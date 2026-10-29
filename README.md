# Ethical AI Metadata Testing

This project collects AI-assisted metadata suggestions from Anthology Ally so reviewers can examine them as part of ethical testing. It currently handles image alt-text suggestions and figure alt text for images found in PDFs. PDF title suggestions are a possible future use, but are not implemented here.

## What It Does

- Retrieves course content and requests caption suggestions through the Ally APIs.
- Supports direct collection with `fetch-captions.sh` and asynchronous batch runs with `ai-ethical-testing.sh`.
- The batch workflow processes configured courses, writes a CSV to S3, and sends a Teams notification with a temporary download link.
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
- A Teams webhook URL if Teams notifications are required

## Deploying the AWS Stack

Install dependencies, configure AWS credentials and region, then bootstrap and deploy the CDK app:

```sh
npm ci
npm run build
export TEAMS_WEBHOOK_URL="<your Teams webhook URL>"
npx cdk bootstrap
npx cdk deploy
unset TEAMS_WEBHOOK_URL
```

The stack expects an SSM parameter at `/application/ai-assistance/configuration/model-id` containing the configured model ID. The deployment role must have access to the required AWS services and the relevant Bedrock model metadata. Keep webhook URLs and bearer tokens out of source control and shell history.

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
      "token": "<course-bearer-token>"
    }
  ]
}
```

Then start and poll the asynchronous job:

```sh
./ai-ethical-testing.sh
```

The script prints the download URL when the job completes. The link expires after 24 hours. Results contain course filenames and generated suggestions; handle them as potentially sensitive data.

## Collecting Captions Directly

`fetch-captions.sh` requests suggestions for each configured label and writes JSON files under `output/<label>/` plus a combined `output/results.csv`:

```sh
./fetch-captions.sh <course-id> "$TOKEN" <client-id>
```

The script currently defines its labels in the `LABELS` array. Use a short-lived token and avoid placing real credentials directly in commands that may be retained in shell history or process listings.

## Generated and Sensitive Files

Do not commit `config.json`, token or cookie files, generated `output/` data, CDK build output, or dependency directories. Results may contain course content or AI-generated text. Use synthetic or approved test data when sharing examples.

## Future Work

- Add explicit, verifiable cohort selection instead of relying on output labels.
- Add documented review criteria and reproducible comparison metrics.
- Evaluate title suggestions for PDFs as a separate workflow.