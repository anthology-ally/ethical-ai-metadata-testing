#!/bin/bash
set -euo pipefail

BASE_URL="https://iyuwysyqub.execute-api.us-east-1.amazonaws.com/run"
POLL_INTERVAL_SECONDS=10

while [[ $# -gt 0 ]]; do
  case $1 in
    *) echo "Unknown parameter: $1"; exit 1;;
  esac
done

start_response=$(curl -s \
  -X POST \
  -H "Content-Type: application/json" \
  -d @config.json \
  "$BASE_URL")

job_id=$(echo "$start_response" | jq -r '.jobId // empty')

if [[ -z "$job_id" ]]; then
  echo "Failed to start job: $start_response" >&2
  exit 1
fi

echo "Job started: $job_id"

while true; do
  status_response=$(curl -s "${BASE_URL}?jobId=${job_id}")
  status=$(echo "$status_response" | jq -r '.status // empty')

  case "$status" in
    COMPLETE)
      echo "Job complete."
      echo "$status_response" | jq -r '.downloadUrl'
      exit 0
      ;;
    FAILED)
      echo "Job failed: $(echo "$status_response" | jq -r '.error')" >&2
      exit 1
      ;;
    RUNNING)
      echo "Job in progress..."
      sleep "$POLL_INTERVAL_SECONDS"
      ;;
    *)
      echo "Unexpected status response: $status_response" >&2
      exit 1
      ;;
  esac
done
