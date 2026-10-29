#!/bin/bash

COURSE_ID=$1
LABELS=("Gender" "Language" "Political" "Race" "Religion" "Sexual" "Violent")
BASE_URL="https://iyuwysyqub.execute-api.us-east-1.amazonaws.com/captions"

# Note: no trailing slash — API Gateway route is /captions not /captions/
TOKEN=$2
CLIENT_ID=$3
if [[ -z "$COURSE_ID" || -z "$TOKEN" || -z "$CLIENT_ID" ]]; then
  echo "Usage: $0 <courseId> <token> <clientId>"
  exit 1
fi

OUTPUT_CSV="output/results.csv"
mkdir -p output
echo "name,caption" > "$OUTPUT_CSV"

for LABEL in "${LABELS[@]}"; do
  DIR="output/$LABEL"
  mkdir -p "$DIR"
  curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$BASE_URL?courseId=$COURSE_ID&label=$LABEL&clientId=$CLIENT_ID" \
    -o "$DIR/$LABEL.json"
  echo "Saved $DIR/$LABEL.json"
  jq -r '.[] | [.name, .caption] | @csv' "$DIR/$LABEL.json" >> "$OUTPUT_CSV"
done

echo "Combined CSV saved to $OUTPUT_CSV"
