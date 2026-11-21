#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --stack NAME (--repo OWNER/REPO | --org ORG) [--dry-run]" >&2
  exit 64
}

stack="" repo="" org="" dry_run=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stack) stack="${2:?}"; shift 2 ;;
    --repo) repo="${2:?}"; shift 2 ;;
    --org) org="${2:?}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
done
[ -n "$stack" ] || usage
[ -n "$repo" ] || [ -n "$org" ] || usage
[ -z "$repo" ] || [ -z "$org" ] || usage

description="$(aws cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0]' --output json)"

output() {
  jq -er --arg key "$1" '.Outputs[] | select(.OutputKey == $key) | .OutputValue' <<<"$description"
}

vars="$(jq -n \
  --arg role "$(output RoleArn)" \
  --arg bucket "$(output BucketName)" \
  --arg function "$(output FunctionName)" \
  --arg region "$(jq -r '.StackId | split(":")[3]' <<<"$description")" \
  --arg audience "$(jq -r '.Parameters[] | select(.ParameterKey == "OidcAudience") | .ParameterValue' <<<"$description")" \
  '{
    CENTAUR_ROLE_ARN: $role,
    CENTAUR_AWS_REGION: $region,
    CENTAUR_FUNCTION_NAME: $function,
    CENTAUR_OIDC_AUDIENCE: $audience,
    CENTAUR_SESSION_BUCKET: $bucket
  }')"

target=(--repo "$repo")
[ -z "$org" ] || target=(--org "$org" --visibility all)

while IFS=$'\t' read -r name value; do
  echo "$name=$value"
  [ -n "$dry_run" ] || gh variable set "$name" --body "$value" "${target[@]}"
done < <(jq -r 'to_entries[] | [.key, .value] | @tsv' <<<"$vars")
