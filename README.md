# Ethical AI Metadata Testing

This project collects AI-assisted metadata suggestions from Anthology Ally so reviewers can examine them as part of ethical testing. It handles image alt-text suggestions, figure alt text for images found in PDFs, and title suggestions for PDFs that do not already have a title.

## What It Does

- Retrieves course content and requests alt-text and PDF-title suggestions through the Ally APIs.
- Supports direct collection with `fetch-captions.sh` and asynchronous batch runs with `ai-ethical-testing.sh`.
- The batch workflow processes configured courses, writes an Excel workbook to S3, and sends a Teams notification with a temporary download link.
- The deployed model ID is read from AWS Systems Manager Parameter Store to identify the model in the report. Suggestion generation itself is performed by the Ally APIs; this project does not invoke a foundation model for inference.

The current implementation is a data-collection aid, not an ethicality or fairness scorer. It does not calculate demographic parity, error rates, or other fairness metrics, and its output requires human review.

## How Ethical Testing Fits In

Ethical testing asks whether AI suggestions are useful and appropriate across relevant content and contexts, and whether quality or error patterns differ between groups. A typical review can:

1. Select comparable content and define the groups or contexts being examined.
2. Collect suggestions using the same model configuration and review criteria.
3. Compare quality, omissions, harmful assumptions, and other relevant failure patterns.
4. Record findings, limitations, and follow-up actions for human review.

This repository automates part of the collection and reporting workflow; it does not define the study design or make conclusions on behalf of reviewers. In the current `/captions` implementation, `label` is added to each output name but is not sent as a filter to the course-content API. The direct collection script repeats the request for each configured label, so do not interpret those output folders as distinct cohorts unless the upstream data is independently confirmed to be filtered.

## Requirements

- Node.js and npm
- AWS CLI credentials with permission to deploy the CDK stack and use Lambda, API Gateway, S3, Systems Manager Parameter Store, and Bedrock model metadata
- AWS CDK v2 (`npx` can run the project dependency)
- `curl` and `jq` for the shell scripts
- An Ally client ID, course IDs, and valid bearer tokens
- An AWS Systems Manager Parameter Store string parameter for the Teams webhook if notifications are required

## Deploying the AWS Stack

Install dependencies, configure AWS credentials and region, then bootstrap and deploy the CDK app:

```sh
npm ci
npm ci --prefix orchestrator
npm run build
npx cdk bootstrap
npx cdk deploy
```

Before deployment, create the Parameter Store parameter `/ally/ethical-ai-metadata-testing/teams-webhook` and set its value to the Teams webhook URL. Create it in the same AWS account and region as the stack. A `String` or `SecureString` parameter is supported; the orchestrator Lambda receives permission to read it at runtime, and the URL itself is not passed through CDK or stored in the Lambda environment. If the webhook has ever been committed or shared, rotate it before storing the replacement.

The stack also expects an SSM parameter at `/application/ai-assistance/configuration/model-id` containing the configured model ID. The deployment role must have access to the required AWS services and the relevant Bedrock model metadata. Keep webhook URLs and bearer tokens out of source control and shell history.

Run the local collector and workbook tests with `npm test`.

After deployment, use the API endpoint printed by CDK. The scripts currently contain a default API endpoint; update their `BASE_URL` values to the endpoint from your own stack before running them.

## Running a Batch

Create a local `config.json` in the project root with the client and courses to process:

```json
{
  "clientId": "<client-id>",
  "courses": [
    {
      "courseId": "<course-id>",
      "name": "<output-label>",
      "token": "<course-bearer-token>",
      "lang": "en"
    }
  ]
}
```

`lang` is optional and defaults to `en`. It is passed to the Ally suggestion endpoints for that course. Existing course entries that omit it continue to use English.

Then start and poll the asynchronous job:

```sh
./ai-ethical-testing.sh
```

The script prints one download URL for `ethical-ai-metadata-testing-results.xlsx` when the job completes; its link expires after 24 hours. The workbook contains:

- **Image Captions:** filenames and generated captions.
- **PDF Results:** one row per PDF figure alt-text suggestion and one title row per PDF, with language, figure index, existing title, suggestion, and status.
- **Run Info:** model name, workbook generation timestamp in UTC, and result row counts.

Each sheet has frozen headers, filters, and wrapped text. Generated suggestions are stored as text rather than spreadsheet formulas. Title statuses distinguish `suggested`, `skipped_existing_title`, `not_tagged`, and `no_suggestion`. Results contain course filenames and generated suggestions; handle them as potentially sensitive data.

In Power Automate, keep the HTTP GET of `downloadUrl` and use its binary Body for SharePoint Create file. Change the saved filename from `.zip` to `triggerBody()?['report_filename']`, which the webhook supplies as `ethical-ai-metadata-testing-results.xlsx`. Keep the existing base64-based CSV branch unchanged. The workbook is downloaded through the URL, not sent as `report_base64`.

## Collecting Captions Directly

`fetch-captions.sh` requests suggestions for each configured label and writes JSON files under `output/<label>/`, `output/results.csv` for non-PDF captions, and `output/pdf-results.csv` for PDF figure alt-text and title suggestions:

```sh
./fetch-captions.sh <course-id> "$TOKEN" <client-id> [lang]
```

The script currently defines its labels in the `LABELS` array. Those labels are output prefixes, not filters applied by the course-content API. Use a short-lived token and avoid placing real credentials directly in commands that may be retained in shell history or process listings.

## Generated and Sensitive Files

Do not commit `config.json`, token or cookie files, generated `output/` data, CDK build output, or dependency directories. Results may contain course content or AI-generated text. Use synthetic or approved test data when sharing examples.

## Future Work

- Add explicit, verifiable cohort selection instead of relying on output labels.
- Add documented review criteria and reproducible comparison metrics.
- Verify the exact title and tag metadata fields returned for course content and align eligibility checks with the Ally API contract.