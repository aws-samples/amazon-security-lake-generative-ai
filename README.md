# **Amazon Security Lake Generative AI**

The project deploys an [Amazon SageMaker Studio](https://aws.amazon.com/sagemaker/studio/) domain and foundational infrastructure to query and load [Amazon Security Lake](https://aws.amazon.com/security-lake/). Once deployed, you can use SageMaker notebooks to use [Amazon Bedrock](https://aws.amazon.com/bedrock/) generative artificial intelligence for use threat hunting and analysis with Amazon Security Lake.

By utilizing Bedrock's generative artificial intelligence capabilities to generate code and queries from natural language input, you will be able quickly utilize SageMaker's capabilities to explore and derive machine learning insights from your Security Lake data. By using all these AWS services together, you can idenfity different areas of interest to focus on and increase your overall security posture.
<br>

## **Prerequisites**

1. [Enable Amazon Security Lake](https://docs.aws.amazon.com/security-lake/latest/userguide/getting-started.html). For multiple AWS accounts, it is recommended to manage [Security Lake for AWS Organizations](https://docs.aws.amazon.com/security-lake/latest/userguide/multi-account-management.html) To help automate and streamline the management of multiple accounts, we strongly recommend that you integrate Security Lake with AWS Organizations.
2. [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/setting-up.html) is available for use in the AWS account. Additionally, you need to [add model access for Claude v2](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html#add-model-access). You will get an error message if you try to use a model before enabling it within your AWS account.
3. [Subcriber Query Access](https://docs.aws.amazon.com/security-lake/latest/userguide/subscriber-query-access.html): Subscribers with query access can query data that Security Lake collects. These subscribers directly query AWS Lake Formation tables in your S3 bucket with services like Amazon Athena.
4. Resource Linking: Create a Lake Formation database in AWS Subcriber account using resource linking
    - Go to Lake Formation in the Subscriber AWS account
    - Create a new database using resource linking
    - Enter Resource Link name
    - Enter Shared database name and shared database Owner ID and click create
<br><br>

## **Solution Architecture**
![Solution Architecture](/sagemaker_gen_ai_architecture.png)

1. (Prerequisite) Security Lake is setup in a separate AWS account with the appropriate sources (i.e. Amazon Virtual Private Cloud (VPC) Flow Logs, AWS Security Hub, AWS CloudTrail, Amazon Route53) configured.
2. (Prerequisite) Create subscriber query access from source Security Lake AWS account to Subscriber AWS account.
3. (Prerequisite) Accepted resource share request in the Subscriber AWS account where this solution is deployed.
4. (Prerequisite) Create a database link in Lake Formation in the Subscriber AWS account and grant access for the Athena tables in the Security Lake AWS account.
5. (Prerequisite) Granted model access for Amazon Bedrock Large Language Model (LLM) Claude v2 in the AWS Subscriber account where the solution will be deployed.
6. A VPC will be provisioned for SageMaker with an IGW, NAT GW, and VPC endpoints for all AWS services within the solution. IGW/NAT is required to install external open-source packages.A
7. A SageMaker Studio domain is created in VPCOnly mode with a single SageMaker user-profile that is tied to an IAM role. As part of the SageMaker deployment, an EFS also gets provisioned for the SageMaker Domain.
8. A dedicated IAM role is created to restrict access to create/access SageMaker Domain’s presigned URL from a specific CIDR for accessing the SageMaker notebook.
9. CodeCommit repository containing python notebooks utilized for the AI/ML workflow by the SageMaker user-profile.
10. Athena workgroup is created for Security Lake queries with a S3 bucket for output location (Access logging configured for the output bucket).
<br><br>

## **Deploy Sagemaker Studio using CDK**

**Build**

To build this app, you need to be in the cdk project root folder [`source`](/source/). Then run the following:

    $ npm install -g aws-cdk
    <installs AWS CDK>

    $ npm install
    <installs appropriate packages>

    $ npm run build
    <build TypeScript files>

**Deploy**

    $ cdk bootstrap aws://<INSERT_AWS_ACCOUNT>/<INSERT_REGION>
    <build S3 bucket to store files to perform deployment>

    $ cdk deploy SageMakerDomainStack
    <deploys the cdk project into the authenticated AWS account>

As part of the CDK deployment, there is an Output value for the CodeCommit repo URL (sagemakernotebookgenairepositoryURL). You will need this value later on to get the python notebooks into your SageMaker app.

## **Post Deployment Steps**

**Access to Security Lake**

Now that you have deployed the SageMaker solution, you will need to grant SageMaker's user-profile in your AWS account access to query Security Lake from the AWS account it was enabled in. We will use the "Grant" permisson to allow the Sagemaker user profile ARN to access Security Lake Database in Lake Formation within the Subscriber AWS account.

**Grant permisson to Security Lake Database**
1. Copy ARN “arn:aws:iam::********************:role/sagemaker-user-profile-for-security-hub” 
2. Go to Lake Formation in console
3. Select the amazon_security_lake_glue_db_<YOUR-REGION>  database.
    1. For example, if your Security Lake is in us-east-1 the value would be amazon_security_lake_glue_db_us_east_1
4. From the Actions  Dropdown, select Grant.
5. In Grant Data  Permissions, select SAML Users and Groups.
6. Paste the SageMaker user  profile ARN from Step 1.
7. In Database  Permissions, select Describe and then Grant.
<br><br> 

**Grant permisson to Security Lake table(s)**
1. Copy the SageMaker user-profile ARN “arn:aws:iam::********************:role/sagemaker-user-profile-for-security-lake” 
2. Go to Lake Formation in console
3. Select the amazon_security_lake_glue_db_<YOUR-REGION>  database.
    1. For example, if your Security Lake is in us-east-1 the value would be amazon_security_lake_glue_db_us_east_1
4. Choose View Tables.
5. Select the amazon_security_lake_table_<YOUR-REGION>_sh_findings_1_0  table.
    1. For example, if your Security Lake is in us-east-1 the value would be amazon_security_lake_table_us_east_1_sh_findings_1_0
    2. Note: Each table must be granted access individually. Selecting “All Tables“ will not grant the appropriate access needed to query Security Lake.
6. From Actions Dropdown, select Grant.
7. In Grant Data  Permissions, select SAML Users and Groups.
8. Paste the SageMaker user-profile ARN from Step 1.
9. In Table Permissions, select Describe and then Grant.
<br>

**CodeCommit**
- Note: The Output (sagemakernotebookgenairepositoryURL) from the CDK deployment will have the CodeCommit repo URL.

##### Option 1: 
1. Open your SageMaker Studio app 
2. In Studio, in the left sidebar, choose the Git icon (identified by a diamond with two branches), then choose Clone a Repository.
3. For the URI, enter the HTTPS URL (Output value for SageMakerDomainStack.sagemakernotebookgenairepositoryURL) of the CodeCommit repository, then choose Clone.
4. In the left sidebar, choose the file browser icon. You will see a folder with the notebook repository

##### Option 2:
1. Open your SageMaker Studio app 
2. In the top navigation bar, choose File >> New >> Terminal
3. Type in the following command: 

    `$ git clone <'Output value for SageMakerDomainStack.sagemakernotebookgenairepositoryURL'>`
    <clones notebook repository>

<br>

## **Using Generative AI and Sagemaker Studio**
Now that you have completed the post deployment steps. You are ready to start using generative AI to assist with threat hunting and analysis. The python notebooks which are deployed as part of the solution provide a starting point for how you can conduct AI/ML analysis using data within Security Lake. These can be expanded to any native or custom data sources configured on Security Lake.
<br>

## Security
See [CONTRIBUTING](https://github.com/aws-samples/aws-security-hub-correlation/blob/main/CONTRIBUTING.md#security-issue-notifications) for more information.

## License
This library is licensed under the MIT-0 License. See the LICENSE file.
