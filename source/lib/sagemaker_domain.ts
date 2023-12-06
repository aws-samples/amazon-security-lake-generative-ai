import { CfnParameter, Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { Key } from "aws-cdk-lib/aws-kms";
import { CfnApp, CfnDomain, CfnUserProfile } from "aws-cdk-lib/aws-sagemaker";
import { join } from 'path';
import { FlowLogDestination, FlowLogTrafficType, Vpc, SubnetType, SecurityGroup, Peer, Port, InterfaceVpcEndpointAwsService, InterfaceVpcEndpointService } from "aws-cdk-lib/aws-ec2";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as athena from 'aws-cdk-lib/aws-athena';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership, StorageClass } from "aws-cdk-lib/aws-s3";
import { EncryptionOption } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { NagSuppressions } from 'cdk-nag';

export class SageMakerDomainStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Parameters to set
    const sagemaker_restrict_cidr_presigned_url = new CfnParameter(this, "sagemaker_restrict_cidr_presigned_url", {
      description: "The IP address to limit accessing SageMaker Studio presigned URL.",
      default: "0.0.0.0/0",
      type: "String"
    }); 

    const IAM_role_assumption_for_sagemaker_presigned_url = new CfnParameter(this, "IAM_role_assumption_for_sagemaker_presigned_url", {
      description: "IAM role to update the trust relationship to allow access to create and access SageMaker Studio's presigned URL.",
//      default: "arn:aws:iam::1234:role/Admin",
      type: "String"
    });

    const security_lake_aws_account = new CfnParameter(this, "security_lake_aws_account", {
      description: "AWS Account where Security Lake has been initially deployed and shared from.",
//      default: "1234",
      type: "String"
    });

    // CodeCommit repository
    const sagemaker_notebook_gen_ai_repository = new codecommit.Repository(this, 'sagemaker_notebook_gen_ai_repository', {
      repositoryName: 'sagemaker_gen_ai_repo',
      description: 'Repository for SageMaker notebooks to run analytics for Security Lake.',
      code: codecommit.Code.fromZipFile(join(__dirname, "../notebooks/notebooks.zip"), "main")
    });

    new CfnOutput(this,'sagemaker-notebook-gen-ai-repository-URL', {
      description:'The CodeCommit repository URL to clone within your SageMaker user-profile notebook.',
      value: sagemaker_notebook_gen_ai_repository.repositoryCloneUrlHttp
    })


    // KMS Key for S3 bucket
    const athena_s3_output_kms_key = new Key(this, "athena_s3_output_kms_key", {
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
      description: "KMS key for S3 bucket to store athena workgroup output.",
      enableKeyRotation: true,
      alias: "athena_s3_output_kms_key"
    });

    // KMS Key for SageMaker Domain
    const sagemaker_kms_key = new Key(this, "sagemaker_kms_key", {
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
      description: "KMS key for SageMaker Domain resources.",
      enableKeyRotation: true,
      alias: "sagemaker_domain_kms_key"
    });

    // Create new VPC with flow logs and Pub/Priv Subnets
    const cw_vpc_flow_logs_parameter = new CfnParameter(this, "cw_flow_logs_parameter", {
      type: "String",
      description: "The cloudwatch log group name for VPC flow logs.",
      default: "/aws/vpc/flowlogs/SageMakerDomainStack",
    });

    const cw_flow_logs = new LogGroup(this, "cw_flow_logs", {
      logGroupName: cw_vpc_flow_logs_parameter.valueAsString,
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_YEAR,
      encryptionKey: sagemaker_kms_key
      });
    
    sagemaker_kms_key.addToResourcePolicy(new iam.PolicyStatement({
      actions: [
        "kms:Encrypt*",
        "kms:Decrypt*",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:Describe*"
      ],
      resources: [
        "*"
      ],
      principals: [
        new iam.ServicePrincipal("logs." + this.region + ".amazonaws.com")
      ],
      conditions:{
        ArnEquals:{
          "kms:EncryptionContext:aws:logs:arn": [
            "arn:aws:logs:" + this.region + ":" + this.account+ ":log-group:" + cw_vpc_flow_logs_parameter.valueAsString
          ]
        }} 
    }));

    // Create SageMaker VPC
    const sagemaker_vpc = new Vpc(this, "sagemaker_vpc", {
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "public_subnet_for_nat_gw",
          subnetType: SubnetType.PUBLIC,
          mapPublicIpOnLaunch: false
        },
        {
          cidrMask: 24,
          name: "workload_subnet_with_nat",
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
      flowLogs: {
        "s3": {
          destination: FlowLogDestination.toCloudWatchLogs(cw_flow_logs),
          trafficType: FlowLogTrafficType.ALL,
      }}
    });

    const sagemaker_workload_sg = new SecurityGroup(this, "sagemaker_workload_sg", {
      vpc: sagemaker_vpc,
      description: "SageMaker Workload SG",
      allowAllOutbound: false,
      securityGroupName: "sagemaker_workload_sg"
    });

    sagemaker_workload_sg.connections.allowTo(sagemaker_workload_sg, Port.tcpRange(8192,65535), "Communication required with SageMaker service-owned VPC")
    sagemaker_workload_sg.connections.allowTo(sagemaker_workload_sg, Port.udp(500), "Communication required with SageMaker service-owned VPC")
    sagemaker_workload_sg.connections.allowTo(sagemaker_workload_sg, Port.esp(), "Communication required with SageMaker service-owned VPC")
    sagemaker_workload_sg.connections.allowTo(Peer.anyIpv4(), Port.tcp(443), "Allow HTTPS Outbound for egress-only internet access")
    sagemaker_workload_sg.connections.allowTo(Peer.anyIpv4(), Port.tcp(80), "Allow HTTP Outbound for egress-only internet access")

    sagemaker_workload_sg.connections.allowFrom(sagemaker_workload_sg, Port.tcpRange(8192,65535), "Communication required with SageMaker service-owned VPC")
    sagemaker_workload_sg.connections.allowFrom(sagemaker_workload_sg, Port.udp(500), "Communication required with SageMaker service-owned VPC")
    sagemaker_workload_sg.connections.allowFrom(sagemaker_workload_sg, Port.esp(), "Communication required with SageMaker service-owned VPC")
    sagemaker_workload_sg.connections.allowFrom(sagemaker_workload_sg, Port.tcp(443), "Allow HTTPS Inbound for VPC interface endpoint")

    sagemaker_vpc.addInterfaceEndpoint("kms_endpoint",{
      service: InterfaceVpcEndpointAwsService.KMS,
      privateDnsEnabled: true,
      subnets: {
         subnets: [
          sagemaker_vpc.selectSubnets({subnetGroupName: "workload_subnet_with_nat"}).subnets[0]
         ]
      },
      securityGroups: (
        [sagemaker_workload_sg]
      )
    });

    sagemaker_vpc.addInterfaceEndpoint("sagemaker_api_endpoint",{
      service: InterfaceVpcEndpointAwsService.SAGEMAKER_API,
      privateDnsEnabled: true,
      subnets: {
         subnets: [
          sagemaker_vpc.selectSubnets({subnetGroupName: "workload_subnet_with_nat"}).subnets[0]
         ]
      },
      securityGroups: (
        [sagemaker_workload_sg]
      )
    });


    sagemaker_vpc.addInterfaceEndpoint("sagemaker_runtime_endpoint",{
      service: InterfaceVpcEndpointAwsService.SAGEMAKER_RUNTIME,
      privateDnsEnabled: true,
      subnets: {
         subnets: [
          sagemaker_vpc.selectSubnets({subnetGroupName: "workload_subnet_with_nat"}).subnets[0]
         ]
      },
      securityGroups: (
        [sagemaker_workload_sg]
      )
    });

    sagemaker_vpc.addInterfaceEndpoint("sagemaker_studio_endpoint",{
      service: new InterfaceVpcEndpointService("aws.sagemaker." + this.region + ".studio", 443),
      privateDnsEnabled: true,
      subnets: {
         subnets: [
          sagemaker_vpc.selectSubnets({subnetGroupName: "workload_subnet_with_nat"}).subnets[0]
         ]
      },
      securityGroups: (
        [sagemaker_workload_sg]
      )
    });

    sagemaker_vpc.addInterfaceEndpoint("athena_endpoint",{
      service: InterfaceVpcEndpointAwsService.ATHENA,
      privateDnsEnabled: true,
      subnets: {
         subnets: [
          sagemaker_vpc.selectSubnets({subnetGroupName: "workload_subnet_with_nat"}).subnets[0]
         ]
      },
      securityGroups: (
        [sagemaker_workload_sg]
      )
    });

    sagemaker_vpc.addInterfaceEndpoint("s3_endpoint",{
      service: new InterfaceVpcEndpointService("com.amazonaws." + this.region + ".s3", 443),
      subnets: {
         subnets: [
          sagemaker_vpc.selectSubnets({subnetGroupName: "workload_subnet_with_nat"}).subnets[0]
         ]
      },
      securityGroups: (
        [sagemaker_workload_sg]
      )
    });

    sagemaker_vpc.addInterfaceEndpoint("codecommit_endpoint",{
      service: InterfaceVpcEndpointAwsService.CODECOMMIT,
      subnets: {
         subnets: [
          sagemaker_vpc.selectSubnets({subnetGroupName: "workload_subnet_with_nat"}).subnets[0]
         ]
      },
      securityGroups: (
        [sagemaker_workload_sg]
      )
    });

    sagemaker_vpc.addInterfaceEndpoint("codecommit_git_endpoint",{
      service: InterfaceVpcEndpointAwsService.CODECOMMIT_GIT,
      subnets: {
         subnets: [
          sagemaker_vpc.selectSubnets({subnetGroupName: "workload_subnet_with_nat"}).subnets[0]
         ]
      },
      securityGroups: (
        [sagemaker_workload_sg]
      )
    });

    // S3 Bucket for Athena output
    const s3_access_logs = new Bucket(this, 's3_access_logs', {
      bucketName: 'athena-gen-ai-s3-access-logs-' + this.account,
      removalPolicy: RemovalPolicy.DESTROY,
      bucketKeyEnabled: true,
      encryption: BucketEncryption.KMS_MANAGED,
      enforceSSL: true,
      versioned: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_PREFERRED,
      publicReadAccess: false,
      lifecycleRules: [{
        expiration: Duration.days(365),
        transitions: [{
            storageClass: StorageClass.INTELLIGENT_TIERING,
            transitionAfter: Duration.days(31)
        }]
    }]
    });

    const athena_output_s3_bucket = new Bucket(this, 'athena_output_s3_bucket', {
      bucketName: 'athena-gen-ai-bucket-results-' + this.account,
      serverAccessLogsBucket: s3_access_logs,
      removalPolicy: RemovalPolicy.DESTROY,
      bucketKeyEnabled: true,
      encryption: BucketEncryption.KMS,
      encryptionKey: athena_s3_output_kms_key,
      enforceSSL: true,
      versioned: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_PREFERRED,
      publicReadAccess: false,
      lifecycleRules: [{
        expiration: Duration.days(365),
        transitions: [{
            storageClass: StorageClass.INTELLIGENT_TIERING,
            transitionAfter: Duration.days(31)
        }]
    }]
    });

    // IAM Role for SageMaker user profiles
    const sagemaker_user_profile_role = new iam.Role(this, "sagemaker_user_profile_role", {
      assumedBy: [
        new iam.ServicePrincipal("sagemaker.amazonaws.com"),
        new iam.ServicePrincipal("bedrock.amazonaws.com"),
    ],
      roleName: "sagemaker-user-profile-for-security-lake",
      managedPolicies: [
      ]
    });

    sagemaker_kms_key.addToResourcePolicy(new iam.PolicyStatement({
      actions: [
        "kms:DescribeKey",
        "kms:Decrypt",
        "kms:GenerateDataKey",
        "kms:CreateGrant"
      ],
      resources: [
        "*"
      ],
      principals: [
        new iam.ArnPrincipal(sagemaker_user_profile_role.roleArn)
      ]
    }));

    const sagemaker_user_profile_policy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: "CloudWatchLogGroupAllow",
          effect: iam.Effect.ALLOW,
          actions: [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents"
          ],
          resources: [
            "arn:aws:logs:" + this.region +":" + this.account + ":log-group:/aws/sagemaker/studio:*"
          ]   
        }),
        new iam.PolicyStatement({
          sid: "S3Read",
          effect: iam.Effect.ALLOW,
          actions: [
            "s3:ListBucket",
            "s3:GetObject",
            "s3:GetBucketAcl",
            "s3:GetBucketLocation"
          ],
          resources: [
            "*"
          ]   
        }),
        new iam.PolicyStatement({
          sid: "S3WriteAllow",
          effect: iam.Effect.ALLOW,
          actions: [
            "s3:AbortMultipartUpload",
            "s3:DeleteObject",
            "s3:PutObject",
            "s3:PutObjectAcl"
          ],
          resources: [
            athena_output_s3_bucket.bucketArn,
            athena_output_s3_bucket.bucketArn + "/*"
          ]   
        }),
        new iam.PolicyStatement({
          sid: "AthenaReadAllow",
          effect: iam.Effect.ALLOW,
          actions: [
            "athena:Get*",
            "athena:List*",
            "athena:StartQueryExecution",
            "athena:StartSession",
            "athena:StopQueryExecution",
          ],
          resources: [
            "arn:aws:athena:" + this.region + ":" + this.account +":datacatalog/*",
            "arn:aws:athena:" + this.region + ":" + this.account +":workgroup/*"
          ]   
        }),
        new iam.PolicyStatement({
          sid: "GlueWriteAllow",
          effect: iam.Effect.ALLOW,
          actions: [
            "glue:CreateDatabase",
            "glue:GetDatabase",
            "glue:GetDatabases",
            "glue:GetTable",
            "glue:GetTables",
            "glue:GetPartition",
            "glue:GetPartitions",
            "glue:BatchGetPartition"
          ],
          resources: [
            "arn:aws:glue:" + this.region + ":" + this.account +":database/*",
            "arn:aws:glue:" + this.region + ":" + this.account +":table/*",
            "arn:aws:glue:" + this.region + ":" + this.account +":catalog",
            "arn:aws:glue:" + this.region + ":" + security_lake_aws_account.valueAsString +":database/*",
            "arn:aws:glue:" + this.region + ":" + security_lake_aws_account.valueAsString +":table/*",
            "arn:aws:glue:" + this.region + ":" + security_lake_aws_account.valueAsString +":catalog",
          ]   
        }),
        new iam.PolicyStatement({
          sid: "LakeFormationAllow",
          effect: iam.Effect.ALLOW,
          actions: [
            "lakeformation:GetDataAccess"
          ],
          resources: [
            "*"
          ]   
        }),
        new iam.PolicyStatement({
          sid: "CodeCommitWriteAllow",
          effect: iam.Effect.ALLOW,
          actions: [
            "codecommit:BatchGet*",
            "codecommit:Describe*",
            "codecommit:Get*",
            "codecommit:List*",
            "codecommit:GitPull",
            "codecommit:GitPush",
            "codecommit:CreateBranch",
            "codecommit:DeleteBranch",
            "codecommit:MergeBranchesBy*",
            "codecommit:UpdateDefaultBranch",
            "codecommit:BatchDescribeMergeConflicts",
            "codecommit:CreateUnreferencedMergeCommit",
            "codecommit:CreateCommit",
            "codecommit:CreatePullRequest",
            "codecommit:CreatePullRequestApprovalRule",
            "codecommit:DeletePullRequestApprovalRule",
            "codecommit:EvaluatePullRequestApprovalRules",
            "codecommit:MergePullRequestBy*",
            "codecommit:PostCommentForPullRequest",
            "codecommit:UpdatePullRequest*",
            "codecommit:PutFile"
          ],
          resources: [
            sagemaker_notebook_gen_ai_repository.repositoryArn
          ]   
        }),
        new iam.PolicyStatement({
          sid: "SageMakerNotResourceAllow",
          effect: iam.Effect.ALLOW,
          actions: [
            "sagemaker:*"
          ],
          notResources: [
            "arn:aws:sagemaker:*:*:domain/*",
            "arn:aws:sagemaker:*:*:user-profile/*",
            "arn:aws:sagemaker:*:*:app/*",
            "arn:aws:sagemaker:*:*:flow-definition/*"
          ]
        }),
        new iam.PolicyStatement({
          sid: "SageMakerDomainAllow",
          effect: iam.Effect.ALLOW,
          actions: [
            "sagemaker:CreatePresignedDomainUrl",
            "sagemaker:DescribeDomain",
            "sagemaker:ListDomains",
            "sagemaker:DescribeUserProfile",
            "sagemaker:ListUserProfiles",
            "sagemaker:*App",
            "sagemaker:ListApps"
          ],
          resources: [
            "arn:aws:sagemaker:*:*:domain/*",
            "arn:aws:sagemaker:*:*:user-profile/*",
            "arn:aws:sagemaker:*:*:app/*",
            "arn:aws:sagemaker:*:*:flow-definition/*"
          ]
        }),
        new iam.PolicyStatement({
          sid: "SageMakerWorkstream",
          effect: iam.Effect.ALLOW,
          actions: [
            "iam:PassRole"
          ],
          resources: [
            "arn:aws:sagemaker:" + this.region + ":" + this.account +":flow-definition/*",
          ],
          conditions: {
            StringEqualsIfExists:{
              "sagemaker:WorkteamType": [
                "private-crowd",
                "vendor-crowd"
              ]
            }} 
        }),
        new iam.PolicyStatement({
          sid: "IAMPassRoletoService",
          effect: iam.Effect.ALLOW,
          actions: [
            "iam:PassRole"
          ],
          resources: [
            sagemaker_user_profile_role.roleArn
          ],
          conditions: {
            StringLike:{
              "iam:PassedToService": [
                "glue.amazonaws.com",
                "robomaker.amazonaws.com",
                "states.amazonaws.com",
                "sagemaker.amazonaws.com"
              ]
            }} 
        }),
        new iam.PolicyStatement({
          sid: "KMSUsePermissions",
          effect: iam.Effect.ALLOW,
          actions: [
            "kms:CreateGrant",
            "kms:DescribeKey",
            "kms:Decrypt",
            "kms:Encrypt",
            "kms:GenerateDataKey",
            "kms:ReEncrypt*"
          ],
          resources: [
            sagemaker_kms_key.keyArn,
            athena_s3_output_kms_key.keyArn
          ]   
        }),
        new iam.PolicyStatement({
          sid: "SageMakerWritePermissions",
          effect: iam.Effect.ALLOW,
          actions: [
            "sagemaker:CreateApp"
          ],
          resources: [
            "arn:aws:sagemaker:" + this.region + ":" + this.account +":app/*",
          ]   
        }),
        new iam.PolicyStatement({
          sid: "BedrockReadPermissions",
          effect: iam.Effect.ALLOW,
          actions: [
            "bedrock:ListFoundationModels",
            "bedrock:GetFoundationModel",
            "bedrock:GetModelCustomizationJob", 
            "bedrock:GetFoundationModelAvailability",
            "bedrock:ListModelCustomizationJobs", 
            "bedrock:GetCustomModel", 
            "bedrock:ListCustomModels", 
            "bedrock:GetProvisionedModelThroughput", 
            "bedrock:ListProvisionedModelThroughputs", 
            "bedrock:ListTagsForResource", 
            "bedrock:GetModelInvocationLoggingConfiguration",
            "bedrock:ListFoundationModelAgreementOffers",
            "bedrock:GetUseCaseForModelAccess",
          ],
          resources: [
            "*"
          ]   
        }),new iam.PolicyStatement({
          sid: "BedrockReadPermissions",
          effect: iam.Effect.ALLOW,
          actions: [
            "bedrock:InvokeModel", 
            "bedrock:InvokeModelWithResponseStream", 
            "bedrock:CreateModelCustomizationJob", 
            "bedrock:StopModelCustomizationJob", 
            "bedrock:DeleteCustomModel",
            "bedrock:CreateProvisionedModelThroughput", 
            "bedrock:UpdateProvisionedModelThroughput", 
            "bedrock:DeleteProvisionedModelThroughput", 
            "bedrock:UntagResource", 
            "bedrock:TagResource", 
            "bedrock:PutFoundationModelEntitlement",
            "bedrock:PutModelInvocationLoggingConfiguration",
            "bedrock:CreateFoundationModelAgreement",
            "bedrock:DeleteFoundationModelAgreement",
            "bedrock:PutUseCaseForModelAccess"
          ],
          resources: [
            "arn:aws:bedrock:" + this.region + "::foundation-model/*",
            "arn:aws:bedrock:" + this.region + ":" + this.account +":custom-model/*",
            "arn:aws:bedrock:" + this.region + ":" + this.account +":provisioned-model/*",
            "arn:aws:bedrock:" + this.region + ":" + this.account +":model-customization-job/*",
            "arn:aws:bedrock:" + this.region + ":" + this.account +":agent/*",
            "arn:aws:bedrock:" + this.region + ":" + this.account +":agent-alias/*",
            "arn:aws:bedrock:" + this.region + ":" + this.account +":knowledge-base/*",
          ]   
        }),
      ],
    });

    athena_output_s3_bucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: [
        's3:PutObject',
        's3:PutObjectAcl',
        's3:DeleteObject',
        's3:GetBucketLocation'
      ],
      resources: [
        athena_output_s3_bucket.bucketArn,
        athena_output_s3_bucket.bucketArn + '/*'
      ],
      principals: [
        new iam.ArnPrincipal(sagemaker_user_profile_role.roleArn)],
    }));

    new iam.ManagedPolicy(this, "SageMakerStudioUserProfileManagedPolicy", {
      description: "Managed policy associated to the SageMaker Studios user profile.",
      document:sagemaker_user_profile_policy,
      managedPolicyName: "sagemaker-studio-user-security-lake-policy",
      roles: [sagemaker_user_profile_role]
    });

    const sagemaker_domain = new CfnDomain(this, "sagemaker_domain", {
      authMode: "IAM",
      defaultUserSettings: {
        executionRole: sagemaker_user_profile_role.roleArn,
        jupyterServerAppSettings: {
          defaultResourceSpec: {
            instanceType: "system",
            // lifecycleConfigArn: "lifecycleConfigArn",
            // sageMakerImageArn: "sageMakerImageArn",
            // sageMakerImageVersionArn: "sageMakerImageVersionArn",
          },
        },
        kernelGatewayAppSettings: {
          // customImages: [{
          //   appImageConfigName: "appImageConfigName",
          //   imageName: "imageName",
    
          //   // the properties below are optional
          //   imageVersionNumber: 123,
          // }],
          defaultResourceSpec: {
            instanceType: "ml.t3.medium",
            // lifecycleConfigArn: "lifecycleConfigArn",
            sageMakerImageArn: "arn:aws:sagemaker:" + this.region + ":081325390199:image/datascience-1.0",
          },
        },
        // rSessionAppSettings: {
        //   customImages: [{
        //     appImageConfigName: "appImageConfigName",
        //     imageName: "imageName",
    
        //     // the properties below are optional
        //     imageVersionNumber: 123,
        //   }],
        //   defaultResourceSpec: {
        //     instanceType: "instanceType",
        //     lifecycleConfigArn: "lifecycleConfigArn",
        //     sageMakerImageArn: "sageMakerImageArn",
        //     sageMakerImageVersionArn: "sageMakerImageVersionArn",
        //   },
        // },
        // rStudioServerProAppSettings: {
        //   accessStatus: "accessStatus",
        //   userGroup: "userGroup",
        // },
        securityGroups: [sagemaker_workload_sg.securityGroupId],
        // sharingSettings: {
        //   notebookOutputOption: "notebookOutputOption",
        //   s3KmsKeyId: "s3KmsKeyId",
        //   s3OutputPath: "s3OutputPath",
        // },
      },
      domainName: "security-lake-gen-ai-" + this.account,
      subnetIds: [sagemaker_vpc.selectSubnets({subnetGroupName: "workload_subnet_with_nat"}).subnets[0].subnetId],
      vpcId: sagemaker_vpc.vpcId,
      // the properties below are optional
      appNetworkAccessType: "VpcOnly",
      // appSecurityGroupManagement: "appSecurityGroupManagement",
      // domainSettings: {
      //   rStudioServerProDomainSettings: {
      //     domainExecutionRoleArn: "domainExecutionRoleArn",
    
      //     // the properties below are optional
      //     defaultResourceSpec: {
      //       instanceType: "instanceType",
      //       lifecycleConfigArn: "lifecycleConfigArn",
      //       sageMakerImageArn: "sageMakerImageArn",
      //       sageMakerImageVersionArn: "sageMakerImageVersionArn",
      //     },
      //     rStudioConnectUrl: "rStudioConnectUrl",
      //     rStudioPackageManagerUrl: "rStudioPackageManagerUrl",
      //   },
      //   securityGroupIds: ["securityGroupIds"],
      // },
      kmsKeyId: sagemaker_kms_key.keyId,
      tags: [{
        key: "project",
        value: "security-lake-gen-ai",
      }],
    });

    sagemaker_domain.applyRemovalPolicy(RemovalPolicy.DESTROY)

    const sagemaker_user_profile = new CfnUserProfile(this, 'sagemaker_user_profile', {
      domainId: sagemaker_domain.attrDomainId,
      userProfileName: sagemaker_user_profile_role.roleName,
    
      // the properties below are optional
      // singleSignOnUserIdentifier: 'singleSignOnUserIdentifier',
      // singleSignOnUserValue: 'singleSignOnUserValue',
      tags: [{
        key: 'project',
        value: 'security-lake-gen-ai',
      }],
      userSettings: {
        executionRole: sagemaker_user_profile_role.roleArn,
        // jupyterServerAppSettings: {
        //   defaultResourceSpec: {
        //     instanceType: 'instanceType',
        //     sageMakerImageArn: 'sageMakerImageArn',
        //     sageMakerImageVersionArn: 'sageMakerImageVersionArn',
        //   },
        // },
        // kernelGatewayAppSettings: {
        //   customImages: [{
        //     appImageConfigName: 'appImageConfigName',
        //     imageName: 'imageName',
    
        //     // the properties below are optional
        //     imageVersionNumber: 123,
        //   }],
        //   defaultResourceSpec: {
        //     instanceType: 'instanceType',
        //     sageMakerImageArn: 'sageMakerImageArn',
        //     sageMakerImageVersionArn: 'sageMakerImageVersionArn',
        //   },
        // },
        // rStudioServerProAppSettings: {
        //   accessStatus: 'accessStatus',
        //   userGroup: 'userGroup',
        // },
        //securityGroups: ['securityGroups'],
        // sharingSettings: {
        //   notebookOutputOption: 'notebookOutputOption',
        //   s3KmsKeyId: 's3KmsKeyId',
        //   s3OutputPath: 's3OutputPath',
        // },
      },
    });

    sagemaker_user_profile.addDependency(sagemaker_domain)
    sagemaker_user_profile.applyRemovalPolicy(RemovalPolicy.DESTROY)

    const sagemaker_app = new CfnApp(this, 'sagemaker_app', {
      appName: 'default',
      appType: 'JupyterServer',
      domainId: sagemaker_domain.attrDomainId,
      userProfileName: sagemaker_user_profile.userProfileName,
    
      // the properties below are optional
      resourceSpec: {
        instanceType: 'system'
      },
      tags: [{
        key: 'project',
        value: 'security-lake-gen-ai',
      }],
    });

    sagemaker_app.addDependency(sagemaker_user_profile)
    sagemaker_app.applyRemovalPolicy(RemovalPolicy.DESTROY)
    
    // IAM Role for SageMaker user profiles
    const sagemaker_console_presigned_url_role = new iam.Role(this, "sagemaker_console_presigned_url_role", {
      assumedBy: new iam.CompositePrincipal(
        new iam.ArnPrincipal(IAM_role_assumption_for_sagemaker_presigned_url.valueAsString),
      ),
      roleName: "sagemaker-console-presigned-url-role",
      // managedPolicies: [
      // ]
    });

    const sagemaker_presigned_url_policy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: "SMStudioCreatePresignedURLAllow",
          effect: iam.Effect.ALLOW,
          actions: [
            "sagemaker:CreatePresignedDomainUrl"
          ],
          resources: [
            sagemaker_user_profile.attrUserProfileArn
          ],
          conditions: {
            IpAddress:{
              "aws:SourceIp": [
                sagemaker_restrict_cidr_presigned_url.valueAsString
              ]
            }}   
        }),
        new iam.PolicyStatement({
          sid: "SMStudioConsoleReadAllow",
          effect: iam.Effect.ALLOW,
          actions: [
            "sagemaker:DescribeDomain",
            "sagemaker:DescribeUserProfile",
            "sagemaker:ListApps",
            "sagemaker:ListDomains",
            "sagemaker:ListUserProfiles",
          ],
          resources: [
            "arn:" + this.partition + ":sagemaker:" + this.region + ":" + this.account + ":domain/*",
            "arn:" + this.partition + ":sagemaker:" + this.region + ":" + this.account + ":user-profile/" + sagemaker_domain.attrDomainId + "/*",
            "arn:" + this.partition + ":sagemaker:" + this.region + ":" + this.account + ":app/" + sagemaker_domain.attrDomainId + "/*"
          ]   
        }),
        new iam.PolicyStatement({
          sid: "SMStudioServiceCatalogReadAllow",
          effect: iam.Effect.ALLOW,
          actions: [
            "license-manager:ListReceivedLicenses",
            "sagemaker:GetSagemakerServicecatalogPortfolioStatus",
            "servicecatalog:ListAcceptedPortfolioShares",
            "servicecatalog:ListPrincipalsForPortfolio"
          ],
          resources: [
            "*"
          ]   
        })
      ],
    });

    new iam.ManagedPolicy(this, "SageMakerStudioConsoleManagedPolicy", {
      description: "Managed policy associated to the AWS console role to access SageMaker Studio Domain presigned URL.",
      document:sagemaker_presigned_url_policy,
      managedPolicyName: "sagemaker-studio-console-access-policy",
      roles: [sagemaker_console_presigned_url_role]
    });

    athena_s3_output_kms_key.addToResourcePolicy(new iam.PolicyStatement({
      actions: [
        'kms:DescribeKey',
        'kms:Encrypt',
        'kms:GenerateDataKey*'
      ],
      resources: [
        '*'
      ],
      principals: [
        new iam.ArnPrincipal(sagemaker_user_profile_role.roleArn)]
    }));

    const gen_ai_workgroup = new athena.CfnWorkGroup(this, 'gen_ai_workgroup', {
      name: 'security_lake_gen_ai',
      // the properties below are optional
      description: 'Workgroup for Security Lake ML and Gen AI.',
      recursiveDeleteOption: true,
      state: 'ENABLED',
      // tags: [{
      //   key: 'key',
      //   value: 'value',
      // }],
      workGroupConfiguration: {
        // bytesScannedCutoffPerQuery: 10000000,
        enforceWorkGroupConfiguration: true,
        // engineVersion: {
        //   effectiveEngineVersion: 'effectiveEngineVersion',
        //   selectedEngineVersion: 'selectedEngineVersion',
        // },
        publishCloudWatchMetricsEnabled: false,
        requesterPaysEnabled: false,
        resultConfiguration: {
          encryptionConfiguration: {
            encryptionOption: EncryptionOption.KMS,
            kmsKey: athena_s3_output_kms_key.keyArn,
          },
          outputLocation: 's3://' + athena_output_s3_bucket.bucketName + '/',
        },
      },
    });

  
    NagSuppressions.addResourceSuppressionsByPath(this,'/SageMakerDomainStack/SageMakerStudioConsoleManagedPolicy/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'The specific actions in the SMStudioServiceCatalogReadAllow SID require * resource. The actions are all read-only.',
        },
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(this,'/SageMakerDomainStack/SageMakerStudioUserProfileManagedPolicy/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'The specific actions in the S3Read and LakeFormationAllow SID require * resource. The actions are all read-only.',
        },
      ]
    );

  }
}
