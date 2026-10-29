import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BedrockClient, GetFoundationModelCommand } from '@aws-sdk/client-bedrock';
import { randomUUID } from 'node:crypto';

const lambdaClient = new LambdaClient();
const s3 = new S3Client();
const ssm = new SSMClient();
const bedrock = new BedrockClient();

const jobKey = (jobId) => `jobs/${jobId}.json`;

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

async function fetchCaptionsForCourse(clientId, courseId, label, token) {
  const event = {
    queryStringParameters: { courseId, label, clientId },
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

function toCsv(rows, modelName) {
  const escape = (val) => `"${String(val).replace(/"/g, '""')}"`;
  const header = 'name,caption';
  const lines = rows.map(r => `${escape(r.name)},${escape(r.caption)}`);
  return [`Model: ${modelName}`, '', header, ...lines].join('\n');
}

async function uploadResultsCsv(csv) {
  const key = `results/${Date.now()}.csv`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.RESULTS_BUCKET,
    Key: key,
    Body: csv,
    ContentType: 'text/csv',
  }));
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: process.env.RESULTS_BUCKET,
    Key: key,
  }), { expiresIn: 86400 });
}

async function postToTeams(downloadUrl, modelName) {
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
        text: 'Link expires in 24 hours.',
        isSubtle: true,
        wrap: true,
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'Download CSV',
        url: downloadUrl,
      },
    ],
  };

  const res = await fetch(process.env.TEAMS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadUrl, modelName, card }),
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

    const allRows = (await Promise.all(
      courses.map(({ courseId, name, token: courseToken }) => fetchCaptionsForCourse(clientId, courseId, name, courseToken))
    )).flat();

    const csv = toCsv(allRows, modelName);
    const downloadUrl = await uploadResultsCsv(csv);
    await postToTeams(downloadUrl, modelName);

    await putJobStatus(jobId, { status: 'COMPLETE', downloadUrl, updatedAt: Date.now() });
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

  const body = JSON.parse(event.body ?? '{}');
  const { clientId, courses } = body;

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
