import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export class CaptionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const teamsWebhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!teamsWebhookUrl) {
      throw new Error('Set TEAMS_WEBHOOK_URL before synthesizing or deploying the stack.');
    }

    const resultsBucket = new s3.Bucket(this, 'ResultsBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        { expiration: cdk.Duration.days(30) },
      ],
    });

    const fn = new lambda.Function(this, 'CaptionSuggestionFn', {
      functionName: 'ai-ethical-testing-function',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda', {
         bundling: {
         image: lambda.Runtime.NODEJS_24_X.bundlingImage,
         command: [
          'bash', '-c',
          'cp -au /asset-input/* /asset-output/ && cd /asset-output && rm -rf node_modules package-lock.json &&npm install --omit=dev --cache /tmp/.npm-cache',
         ],
  },
        },
      ),
      timeout: cdk.Duration.minutes(5),
      environment: {
        GET_DOCUMENT_CONTENT_URL:
        'https://performance.ally.ac/api/v1/{clientId}/courses/{courseId}/rich-content/{fileId}/link',
        PDF_CAPTION_SUGGESTION_URL:
          'https://performance.ally.ac/api/v2/clients/{clientId}/courses/{courseId}/pdf/alttext/{fileId}/suggestion?figureIndex={figureIndex}&lang=en',
        CAPTION_SUGGESTION_URL:
          'https://performance.ally.ac/api/v2/clients/{clientId}/courses/{courseId}/files/{fileId}/captions/suggestion?lang=en',
        GET_CONTENT_URL:
          'https://performance.ally.ac/api/v1/{clientId}/reports/courses/{courseId}/content',
        GET_PDF_CONTENT_URL:
          'https://performance.ally.ac/api/v1/{clientId}/courses/{courseId}/files/{fileId}/embedInfo',
      },
    });

    const orchestratorFunctionName = 'ai-ethical-testing-orchestrator';

    const modelIdParameterName = '/application/ai-assistance/configuration/model-id';

    const orchestratorFn = new lambda.Function(this, 'OrchestratorFn', {
      functionName: orchestratorFunctionName,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('orchestrator'),
      timeout: cdk.Duration.minutes(15),
      environment: {
        CAPTIONS_FUNCTION_NAME: fn.functionName,
        RESULTS_BUCKET: resultsBucket.bucketName,
        MODEL_ID_PARAMETER_NAME: modelIdParameterName,
        TEAMS_WEBHOOK_URL: teamsWebhookUrl,
      },
    });

    fn.grantInvoke(orchestratorFn);
    resultsBucket.grantPut(orchestratorFn);
    resultsBucket.grantRead(orchestratorFn);

    ssm.StringParameter.fromStringParameterName(
      this,
      'ModelIdParameter',
      modelIdParameterName,
    ).grantRead(orchestratorFn);

    // Bedrock foundation models are AWS-owned public resources (no account ID
    // in the ARN) — there's no CDK grant helper for them, so add the policy
    // statement directly.
    orchestratorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:GetFoundationModel'],
      resources: [`arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/*`],
    }));

    // Self-invoke permission for the async worker re-invocation. Built from the
    // literal function name (not orchestratorFn.functionName, which resolves via
    // Ref to the function's own logical id) to avoid a circular dependency: the
    // function already depends on its role's default policy, and a reference back
    // to the function within that same policy would create a cycle.
    const orchestratorFnArn = cdk.Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: orchestratorFunctionName,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    orchestratorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [orchestratorFnArn, `${orchestratorFnArn}:*`],
    }));

    const api = new apigwv2.HttpApi(this, 'CaptionApi');

    api.addRoutes({
      path: '/captions',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('CaptionIntegration', fn),
    });

    const orchestratorIntegration = new integrations.HttpLambdaIntegration('OrchestratorIntegration', orchestratorFn);

    api.addRoutes({
      path: '/run',
      methods: [apigwv2.HttpMethod.POST],
      integration: orchestratorIntegration,
    });

    api.addRoutes({
      path: '/run',
      methods: [apigwv2.HttpMethod.GET],
      integration: orchestratorIntegration,
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `${api.apiEndpoint}/captions?courseId=<courseId>&label=<label>`,
    });

    new cdk.CfnOutput(this, 'RunUrl', {
      value: `${api.apiEndpoint}/run?courseId=<courseId>&clientId=<clientId>`,
    });

    new cdk.CfnOutput(this, 'JobStatusUrl', {
      value: `${api.apiEndpoint}/run?jobId=<jobId>`,
    });
  }
}
