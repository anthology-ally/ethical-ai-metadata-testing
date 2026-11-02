import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BedrockClient, GetFoundationModelCommand } from '@aws-sdk/client-bedrock';
import { randomUUID } from 'node:crypto';
import { createResultsWorkbook } from './results-workbook.mjs';

const lambdaClient = new LambdaClient();
const s3 = new S3Client();
const ssm = new SSMClient();
const bedrock = new BedrockClient();

const jobKey = (jobId) => `jobs/${jobId}.json`;
const reportFilename = 'ethical-ai-metadata-testing-results.xlsx';
const workbookContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Cross-region inference profile IDs (e.g. "us.anthropic.claude-sonnet-5")
// aren't valid GetFoundationModel identifiers — strip the region prefix to
// get the underlying model ID.
async function getModelDisplayName() {
  const { Parameter } = await ssm.send(new GetParameterCommand({
    Name: process.env.MODEL_ID_PARAMETER_NAME,
  }));
  const baseModelId = Parameter.Value.replace(/^(us|eu|apac)\./, '');
  const { modelDetails } = await bedrock.send(new GetFoundationModelCommand({
    modelIdentifier: baseModelId,
  }));
  return `${modelDetails.providerName} ${modelDetails.modelName}`;
}

async function fetchCaptionsForCourse(clientId, courseId, label, token, lang) {
  const event = {
    queryStringParameters: { courseId, label, clientId, lang },
    headers: { authorization: `Bearer ${token}` },
  };
  const res = await lambdaClient.send(new InvokeCommand({
    FunctionName: process.env.CAPTIONS_FUNCTION_NAME,
    Payload: JSON.stringify(event),
  }));
  const payload = JSON.parse(Buffer.from(res.Payload));
  if (payload.statusCode !== 200) throw new Error(`Failed for label ${label}: ${payload.body}`);
  return JSON.parse(payload.body);
}

async function uploadResultsWorkbook(captionRows, pdfRows, modelName) {
  const key = `results/${Date.now()}.xlsx`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.RESULTS_BUCKET,
    Key: key,
    Body: await createResultsWorkbook(captionRows, pdfRows, modelName),
    ContentType: workbookContentType,
  }));
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: process.env.RESULTS_BUCKET,
    Key: key,
    ResponseContentType: workbookContentType,
    ResponseContentDisposition: `attachment; filename="${reportFilename}"`,
  }), { expiresIn: 86400 });
}

async function postToTeams(downloadUrl, modelName) {
  const { Parameter } = await ssm.send(new GetParameterCommand({
    Name: process.env.TEAMS_WEBHOOK_PARAMETER_NAME,
    WithDecryption: true,
  }));
  const webhookUrl = Parameter?.Value;
  if (!webhookUrl) throw new Error('Teams webhook secret has no string value');

  const card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: 'AI Ethical Testing results are ready.',
        weight: 'Bolder',
        size: 'Medium',
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: `Model: ${modelName}`,
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: 'The workbook contains Image Captions, PDF Results, and Run Info sheets. The link expires in 24 hours.',
        isSubtle: true,
        wrap: true,
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'Download Excel results',
        url: downloadUrl,
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadUrl, report_filename: reportFilename, modelName, card }),
  });
  if (!res.ok) throw new Error(`Teams webhook failed: ${res.status}`);
}

async function putJobStatus(jobId, status) {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.RESULTS_BUCKET,
    Key: jobKey(jobId),
    Body: JSON.stringify(status),
    ContentType: 'application/json',
  }));
}

async function getJobStatus(jobId) {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: process.env.RESULTS_BUCKET,
      Key: jobKey(jobId),
    }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function runJob(jobId, clientId, courses) {
  try {
    const modelName = await getModelDisplayName();

    const courseResults = await Promise.all(
      courses.map(({ courseId, name, token: courseToken, lang = 'en' }) =>
        fetchCaptionsForCourse(clientId, courseId, name, courseToken, lang))
    );
    const captionRows = courseResults.flatMap(({ captions }) => captions);
    const pdfRows = courseResults.flatMap(({ pdfs }) => pdfs);

    const downloadUrl = await uploadResultsWorkbook(captionRows, pdfRows, modelName);
    await postToTeams(downloadUrl, modelName);

    await putJobStatus(jobId, {
      status: 'COMPLETE',
      downloadUrl,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error(`Job ${jobId} failed:`, err);
    await putJobStatus(jobId, { status: 'FAILED', error: err.message, updatedAt: Date.now() });
  }
}

export const handler = async (event, context) => {
  // Async self-invocation that does the actual orchestration work in the background.
  if (event.action === 'run-job') {
    await runJob(event.jobId, event.clientId, event.courses);
    return;
  }

  const method = event.requestContext?.http?.method;

  if (method === 'GET') {
    const jobId = event.queryStringParameters?.jobId;
    if (!jobId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'jobId query parameter is required' }) };
    }
    const job = await getJobStatus(jobId);
    if (!job) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Job not found' }) };
    }
    return { statusCode: 200, body: JSON.stringify(job) };
  }

  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Request body must be valid JSON' }),
    };
  }
  const { clientId, courses } = body ?? {};

  if (!clientId || !Array.isArray(courses) || courses.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'clientId and courses array are required' }),
    };
  }

  const jobId = randomUUID();
  await putJobStatus(jobId, { status: 'RUNNING', createdAt: Date.now() });

  await lambdaClient.send(new InvokeCommand({
    FunctionName: context.functionName,
    InvocationType: 'Event',
    Payload: JSON.stringify({ action: 'run-job', jobId, clientId, courses }),
  }));

  return {
    statusCode: 202,
    body: JSON.stringify({ jobId }),
  };
};
