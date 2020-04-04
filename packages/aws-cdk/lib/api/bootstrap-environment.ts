import * as cxschema from '@aws-cdk/cloud-assembly-schema';
import * as cxapi from '@aws-cdk/cx-api';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { Tag } from '../cdk-toolkit';
import { Mode, SdkProvider } from './aws-auth';
import { deployStack, DeployStackResult } from './deploy-stack';

// tslint:disable:max-line-length

/** @experimental */
export const BUCKET_NAME_OUTPUT = 'BucketName';
/** @experimental */
export const REPOSITORY_NAME_OUTPUT = 'RepositoryName';
/** @experimental */
export const BUCKET_DOMAIN_NAME_OUTPUT = 'BucketDomainName';

export interface BootstrapEnvironmentProps {
  /**
   * The name to be given to the CDK Bootstrap bucket.
   *
   * @default - a name is generated by CloudFormation.
   */
  readonly bucketName?: string;

  /**
   * The ID of an existing KMS key to be used for encrypting items in the bucket.
   *
   * @default - the default KMS key for S3 will be used.
   */
  readonly kmsKeyId?: string;
  /**
   * Tags for cdktoolkit stack.
   *
   * @default - None.
   */
  readonly tags?: Tag[];
  /**
   * Whether to execute the changeset or only create it and leave it in review.
   * @default true
   */
  readonly execute?: boolean;

  /**
   * The list of AWS account IDs that are trusted to deploy into the environment being bootstrapped.
   *
   * @default - only the bootstrapped account can deploy into this environment
   */
  readonly trustedAccounts?: string[];

  /**
   * The ARNs of the IAM managed policies that should be attached to the role performing CloudFormation deployments.
   * In most cases, this will be the AdministratorAccess policy.
   * At least one policy is required if {@link trustedAccounts} were passed.
   *
   * @default - the role will have no policies attached
   */
  readonly cloudFormationExecutionPolicies?: string[];
}

/** @experimental */
export async function bootstrapEnvironment(environment: cxapi.Environment, sdkProvider: SdkProvider, toolkitStackName: string, roleArn: string | undefined, props: BootstrapEnvironmentProps = {}): Promise<DeployStackResult> {
  if (props.trustedAccounts?.length) {
    throw new Error('--trust can only be passed for the new bootstrap experience!');
  }
  if (props.cloudFormationExecutionPolicies?.length) {
    throw new Error('--cloudformation-execution-policies can only be passed for the new bootstrap experience!');
  }

  const template = {
    Description: "The CDK Toolkit Stack. It was created by `cdk bootstrap` and manages resources necessary for managing your Cloud Applications with AWS CDK.",
    Resources: {
      StagingBucket: {
        Type: "AWS::S3::Bucket",
        Properties: {
          BucketName: props.bucketName,
          AccessControl: "Private",
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [{
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "aws:kms",
                KMSMasterKeyID: props.kmsKeyId,
              },
            }]
          },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
        }
      }
    },
    Outputs: {
      [BUCKET_NAME_OUTPUT]: {
        Description: "The name of the S3 bucket owned by the CDK toolkit stack",
        Value: { Ref: "StagingBucket" }
      },
      [BUCKET_DOMAIN_NAME_OUTPUT]: {
        Description: "The domain name of the S3 bucket owned by the CDK toolkit stack",
        Value: { "Fn::GetAtt": ["StagingBucket", "RegionalDomainName"] }
      }
    }
  };

  const outdir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdk-bootstrap'));
  const builder = new cxapi.CloudAssemblyBuilder(outdir);
  const templateFile = `${toolkitStackName}.template.json`;

  await fs.writeJson(path.join(builder.outdir, templateFile), template, { spaces: 2 });

  builder.addArtifact(toolkitStackName, {
    type: cxschema.ArtifactType.AWS_CLOUDFORMATION_STACK,
    environment: cxapi.EnvironmentUtils.format(environment.account, environment.region),
    properties: {
      templateFile
    },
  });

  const assembly = builder.buildAssembly();

  const resolvedEnvironment = await sdkProvider.resolveEnvironment(environment.account, environment.region);

  return await deployStack({
    stack: assembly.getStackByName(toolkitStackName),
    resolvedEnvironment,
    sdk: await sdkProvider.forEnvironment(environment.account, environment.region, Mode.ForWriting),
    sdkProvider,
    roleArn,
    tags: props.tags,
    execute: props.execute
  });
}
