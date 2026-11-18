#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --stack NAME --code-bucket BUCKET [--params-file FILE] [PARAM=VALUE ...]" >&2
  exit 64
}

stack="" code_bucket="" params_file=""
overrides=()
while [ $# -gt 0 ]; do
  case "$1" in
    --stack) stack="${2:?}"; shift 2 ;;
    --code-bucket) code_bucket="${2:?}"; shift 2 ;;
    --params-file) params_file="${2:?}"; shift 2 ;;
    -h | --help) usage ;;
    *=*) overrides+=("$1"); shift ;;
    *) usage ;;
  esac
done
[ -n "$stack" ] && [ -n "$code_bucket" ] || usage

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

npm run --silent bundle:lambda
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
cp dist/lambda/index.mjs "$build/index.mjs"
(cd "$build" && zip -q -X lambda.zip index.mjs)
code_key="centaur/lambda-$(shasum -a 256 "$build/lambda.zip" | cut -c1-16).zip"
aws s3 cp --only-show-errors "$build/lambda.zip" "s3://$code_bucket/$code_key"

file_overrides=()
if [ -n "$params_file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) ;; *) file_overrides+=("$line") ;; esac
  done <"$params_file"
fi

aws cloudformation deploy \
  --stack-name "$stack" \
  --template-file infra/centaur.yml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
  "CodeBucket=$code_bucket" "CodeKey=$code_key" \
  ${file_overrides[@]+"${file_overrides[@]}"} ${overrides[@]+"${overrides[@]}"}

aws cloudformation describe-stacks --stack-name "$stack" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
