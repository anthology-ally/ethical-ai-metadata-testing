#!/bin/bash

COURSE_ID=$1
LABELS=("Gender" "Language" "Political" "Race" "Religion" "Sexual" "Violent")
BASE_URL="https://iyuwysyqub.execute-api.us-east-1.amazonaws.com/captions"
REQUEST_LANG=${4:-en}

# Note: no trailing slash — API Gateway route is /captions not /captions/
TOKEN=$2
CLIENT_ID=$3
if [[ -z "$COURSE_ID" || -z "$TOKEN" || -z "$CLIENT_ID" ]]; then
  echo "Usage: $0 <courseId> <token> <clientId> [lang]"
  exit 1
fi

OUTPUT_CSV="output/results.csv"
PDF_OUTPUT_CSV="output/pdf-results.csv"
mkdir -p output
echo "name,caption" > "$OUTPUT_CSV"
echo "name,type,language,figureIndex,existingTitle,suggestion,status" > "$PDF_OUTPUT_CSV"
INCLUDE_PDFS=true

for LABEL in "${LABELS[@]}"; do
  DIR="output/$LABEL"
  mkdir -p "$DIR"
  curl -s \
    -H "Authorization: Bearer $TOKEN" \
    --get \
    --data-urlencode "courseId=$COURSE_ID" \
    --data-urlencode "label=$LABEL" \
    --data-urlencode "clientId=$CLIENT_ID" \
    --data-urlencode "lang=$REQUEST_LANG" \
    --data-urlencode "includePdfs=$INCLUDE_PDFS" \
    "$BASE_URL" \
    -o "$DIR/$LABEL.json"
  echo "Saved $DIR/$LABEL.json"
  jq -r '.captions[]? | [.name, .caption] | @csv' "$DIR/$LABEL.json" >> "$OUTPUT_CSV"
  jq -r '.pdfs[]? | [.name, .type, .language, (.figureIndex // ""), (.existingTitle // ""), .suggestion, .status] | @csv' "$DIR/$LABEL.json" >> "$PDF_OUTPUT_CSV"
  INCLUDE_PDFS=false
done

echo "Combined CSV saved to $OUTPUT_CSV"
echo "PDF results saved to $PDF_OUTPUT_CSV"
