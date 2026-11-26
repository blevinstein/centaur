#!/usr/bin/env bash
# One-time setup for continuous deployment (docs/deploy.md, "Continuous deployment").
#
#   scripts/setup-cd.sh environment   Create the `production` environment limited to main. Run first,
#                                     before merging or pushing the deploy workflow. Idempotent.
#   scripts/setup-cd.sh credentials   After the first manual `yarn deploy-prod`: set the
#                                     DEPLOY_ROLE_ARN variable and the DEPLOY_PARAMETERS secret.
#                                     Refuses unless the environment is restricted to main.
#   scripts/setup-cd.sh check         Read-only status and what is still missing, in step order.
#
# Flags: --repo OWNER/REPO (default: the current repository), --stack NAME (default centaur),
#        --params-file FILE (default parameters-prod.json), --dry-run (print the commands, run nothing).
# Needs gh (admin on the repository), aws and jq.
set -euo pipefail

usage() {
  sed -n '2,/^set -/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2
  exit 64
}

fail() {
  echo "error: $*" >&2
  exit 1
}

cmd="${1:-}"
[ -n "$cmd" ] || usage
shift
repo="" stack="centaur" params_file="parameters-prod.json" dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:?}"; shift 2 ;;
    --stack) stack="${2:?}"; shift 2 ;;
    --params-file) params_file="${2:?}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
done

env_name=production
deploy_branch=main

if [ -z "$repo" ]; then
  if [ "$dry_run" = 1 ]; then
    repo="<owner/repo>"
  else
    repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
  fi
fi

run() {
  echo "+ $*"
  [ "$dry_run" = 1 ] || "$@"
}

env_api="repos/$repo/environments/$env_name"

# Prints what is wrong and returns 1 unless the environment exists with custom branch policies and
# exactly one policy, for main.
verify_environment() {
  local env policies
  env="$(gh api "$env_api" 2>/dev/null)" || {
    echo "environment $env_name: missing"
    return 1
  }
  policies="$(gh api "$env_api/deployment-branch-policies")"
  jq -e '.deployment_branch_policy.custom_branch_policies == true' <<<"$env" >/dev/null || {
    echo "environment $env_name: not restricted to custom branch policies"
    return 1
  }
  jq -e --arg b "$deploy_branch" '.branch_policies | length == 1 and .[0].name == $b' \
    <<<"$policies" >/dev/null || {
    echo "environment $env_name: branch policies are not exactly [$deploy_branch]:" \
      "$(jq -c '[.branch_policies[].name]' <<<"$policies")"
    return 1
  }
  echo "environment $env_name: restricted to $deploy_branch"
}

names() {
  gh "$1" list --repo "$repo" --json name | jq -r '.[].name'
}

has_name() {
  names "$1" | grep -qx "$2"
}

stack_role_arn() {
  local arn
  arn="$(aws cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text 2>/dev/null)" || return 1
  [ -n "$arn" ] && [ "$arn" != "None" ] || return 1
  echo "$arn"
}

cmd_environment() {
  if [ "$dry_run" = 1 ]; then
    echo "+ gh api $env_api  (skipped when it already restricts to $deploy_branch)"
    echo "+ gh api -X PUT $env_api --input -  (body: custom_branch_policies true)"
    echo "+ gh api -X POST $env_api/deployment-branch-policies -f name=$deploy_branch -f type=branch"
    return 0
  fi
  local env policies
  env="$(gh api "$env_api" 2>/dev/null || true)"
  if ! jq -e '.deployment_branch_policy.custom_branch_policies == true' <<<"${env:-null}" >/dev/null 2>&1; then
    run gh api -X PUT "$env_api" --input - \
      <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
  fi
  policies="$(gh api "$env_api/deployment-branch-policies")"
  if ! jq -e --arg b "$deploy_branch" 'any(.branch_policies[]; .name == $b)' <<<"$policies" >/dev/null; then
    run gh api -X POST "$env_api/deployment-branch-policies" -f "name=$deploy_branch" -f type=branch
  fi
  verify_environment
}

validate_params_file() {
  [ -f "$params_file" ] || fail "parameters file not found: $params_file"
  jq -e 'type == "array" and length > 0 and all(.[]; type == "object"
      and (.ParameterKey | type == "string") and (.ParameterValue | type == "string"))' \
    "$params_file" >/dev/null 2>&1 ||
    fail "$params_file must be a JSON array of {ParameterKey, ParameterValue} string pairs"
}

cmd_credentials() {
  validate_params_file
  if [ "$dry_run" = 1 ]; then
    echo "+ aws cloudformation describe-stacks --stack-name $stack  (DeployRoleArn output)"
    echo "+ gh api $env_api  (must be restricted to $deploy_branch)"
    echo "+ gh variable list --repo $repo  (CENTAUR_AWS_REGION must exist)"
    echo "+ gh variable set DEPLOY_ROLE_ARN --repo $repo --body <DeployRoleArn>"
    echo "+ jq -c . $params_file | gh secret set DEPLOY_PARAMETERS --repo $repo"
    return 0
  fi
  local arn
  arn="$(stack_role_arn)" ||
    fail "stack $stack has no DeployRoleArn output: run the first manual deploy (yarn deploy-prod) from the merged commit"
  verify_environment || fail "run 'scripts/setup-cd.sh environment' first"
  has_name variable CENTAUR_AWS_REGION || fail "repository variable CENTAUR_AWS_REGION is not set on $repo"
  run gh variable set DEPLOY_ROLE_ARN --repo "$repo" --body "$arn"
  echo "+ jq -c . $params_file | gh secret set DEPLOY_PARAMETERS --repo $repo"
  jq -c . "$params_file" | gh secret set DEPLOY_PARAMETERS --repo "$repo"
}

cmd_check() {
  local missing=() arn=""
  verify_environment || missing+=("1. environment: scripts/setup-cd.sh environment")
  if arn="$(stack_role_arn)"; then
    echo "stack $stack: DeployRoleArn output present"
    if aws iam get-role --role-name "${arn##*/}" >/dev/null 2>&1; then
      echo "deploy role: found"
    else
      echo "deploy role: not found (or not readable with these credentials)"
    fi
  else
    echo "stack $stack: no DeployRoleArn output"
    missing+=("3. first manual deploy: yarn deploy-prod, from the merged commit")
  fi
  for item in "variable CENTAUR_AWS_REGION" "variable DEPLOY_ROLE_ARN" "secret DEPLOY_PARAMETERS"; do
    if has_name "${item% *}" "${item#* }"; then
      echo "$item: set"
    else
      echo "$item: missing"
      missing+=("4. $item: scripts/setup-cd.sh credentials")
    fi
  done
  if gh api "repos/$repo/branches/$deploy_branch/protection" >/dev/null 2>&1; then
    echo "branch protection on $deploy_branch: enabled"
  else
    echo "branch protection on $deploy_branch: not enabled (optional, a separate decision)"
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    echo "still missing:"
    printf '  %s\n' "${missing[@]}"
    return 1
  fi
}

case "$cmd" in
  environment) cmd_environment ;;
  credentials) cmd_credentials ;;
  check) cmd_check ;;
  *) usage ;;
esac
