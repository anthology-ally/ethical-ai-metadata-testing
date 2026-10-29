#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CaptionStack } from '../lib/caption-stack';

const app = new cdk.App();
new CaptionStack(app, 'CaptionStack');
