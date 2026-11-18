#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --stack NAME [--params-file FILE.json] [Name=Value ...]" >&2
  exit 64
}

stack="" params_file=""
overrides=()
while [ $# -gt 0 ]; do
  case "$1" in
    --stack) stack="${2:?}"; shift 2 ;;
    --params-file) params_file="${2:?}"; shift 2 ;;
    -h | --help) usage ;;
    *=*) overrides+=("$1"); shift ;;
    *) usage ;;
  esac
done
[ -n "$stack" ] || usage

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

file_overrides=()
if [ -n "$params_file" ]; then
  converted="$(jq -r '.[] | "\(.ParameterKey)=\(.ParameterValue)"' "$params_file")"
  while IFS= read -r line; do
    [ -z "$line" ] || file_overrides+=("$line")
  done <<<"$converted"
fi

deploy() {
  aws cloudformation deploy \
    --stack-name "$stack" \
    --template-file infra/centaur.yml \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset \
    --parameter-overrides \
    ${file_overrides[@]+"${file_overrides[@]}"} ${overrides[@]+"${overrides[@]}"} "$@"
}

code_bucket() {
  aws cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='CodeBucketName'].OutputValue" \
    --output text 2>/dev/null || true
}

yarn bundle:lambda
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
cp dist/lambda/index.mjs "$build/index.mjs"
(cd "$build" && zip -q -X lambda.zip index.mjs)
code_key="centaur/lambda-$(shasum -a 256 "$build/lambda.zip" | cut -c1-16).zip"

bucket="$(code_bucket)"
if [ -z "$bucket" ] || [ "$bucket" = "None" ]; then
  deploy DeployLambda=FALSE
  bucket="$(code_bucket)"
fi

aws s3 cp --only-show-errors "$build/lambda.zip" "s3://$bucket/$code_key"
deploy DeployLambda=TRUE "CodeKey=$code_key"

aws cloudformation describe-stacks --stack-name "$stack" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
