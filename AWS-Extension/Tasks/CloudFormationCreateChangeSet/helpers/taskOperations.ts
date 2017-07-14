import tl = require('vsts-task-lib/task');
import path = require('path');
import fs = require('fs');
import awsCloudFormation = require('aws-sdk/clients/cloudformation');
import awsS3 = require('aws-sdk/clients/s3');
import { AWSError } from 'aws-sdk/lib/error';

import TaskParameters = require('./taskParameters');

export class TaskOperations {

    public static async createChangeSet(taskParameters: TaskParameters.CreateChangeSetTaskParameters): Promise<void> {
        this.createServiceClients(taskParameters);

        let stackId: string;
        switch (taskParameters.templateLocation) {
            case 'LinkedArtifact': {
                stackId = await this.createChangeSetFromTemplateFile(taskParameters);
            }
            break;

            case 'FileURL': {
                stackId = await this.createChangeSetFromTemplateUrl(taskParameters);
            }
            break;

            case 'UsePrevious': {
                stackId = await this.createChangeSetFromOriginalTemplate(taskParameters);
            }
            break;

            default:
                throw new Error(`Unknown templateLocation mode {taskParameters.templateLocation}`);
        }

        if (taskParameters.autoExecute) {
            this.executeChangeSet(taskParameters.changeSetName, taskParameters.stackName);
        }

        if (taskParameters.outputVariable) {
            console.log(tl.loc('SettingOutputVariable', taskParameters.outputVariable));
            tl.setVariable(taskParameters.outputVariable, stackId);
        }

        console.log(tl.loc('TaskCompleted', taskParameters.changeSetName, stackId));
    }

    private static cloudFormationClient: awsCloudFormation;

    private static s3Client: awsS3;

    private static createServiceClients(taskParameters: TaskParameters.CreateChangeSetTaskParameters) {
        this.cloudFormationClient = new awsCloudFormation({
            apiVersion: '2010-05-15',
            credentials: {
                accessKeyId: taskParameters.awsKeyId,
                secretAccessKey: taskParameters.awsSecretKey
            },
            region: taskParameters.awsRegion
        });

        this.s3Client = new awsS3({
            apiVersion: '2006-03-01',
            credentials: {
                accessKeyId: taskParameters.awsKeyId,
                secretAccessKey: taskParameters.awsSecretKey
            },
            region: taskParameters.awsRegion
        });
    }

    private static async createChangeSetFromOriginalTemplate(taskParameters: TaskParameters.CreateChangeSetTaskParameters) : Promise<string> {
        console.log(tl.loc('CreatingChangesetFromPreviousTemplate'));

        let templateParameters: awsCloudFormation.Parameters;

        try {
            if (taskParameters.cfParametersFile) {
                console.log(tl.loc('LoadingTemplateParameterFile', taskParameters.cfParametersFile));
                templateParameters = JSON.parse(fs.readFileSync(taskParameters.cfParametersFile, 'utf8'));
                tl.debug('Successfully loaded template file');
            }
        } catch (err) {
            console.error(tl.loc('TemplateFilesLoadFailure', err.message), err);
            throw err;
        }

        const request: awsCloudFormation.CreateChangeSetInput = {
            ChangeSetName: taskParameters.changeSetName,
            ChangeSetType: taskParameters.changeSetType,
            StackName: taskParameters.stackName,
            UsePreviousTemplate: true,
            Parameters: templateParameters,
            Description: taskParameters.description,
            NotificationARNs: taskParameters.notificationARNs,
            ResourceTypes: taskParameters.resourceTypes,
            RoleARN: taskParameters.roleARN
        };

        return await this.createChangeSetFromRequest(request);
    }

    private static async createChangeSetFromTemplateFile(taskParameters: TaskParameters.CreateChangeSetTaskParameters) : Promise<string> {
        console.log(tl.loc('CreatingChangesetFromFiles', taskParameters.cfTemplateFile, taskParameters.cfParametersFile));

        let template: string;
        let templateParameters: awsCloudFormation.Parameters;

        try {
            console.log(tl.loc('LoadingTemplateFile', taskParameters.cfTemplateFile));
            template = fs.readFileSync(taskParameters.cfTemplateFile, 'utf8');
            tl.debug('Successfully loaded template file');

            if (taskParameters.cfParametersFile) {
                console.log(tl.loc('LoadingTemplateParameterFile', taskParameters.cfParametersFile));
                templateParameters = JSON.parse(fs.readFileSync(taskParameters.cfParametersFile, 'utf8'));
                tl.debug('Successfully loaded template file');
            }
        } catch (err) {
            console.error(tl.loc('TemplateFilesLoadFailure', err.message), err);
            throw err;
        }

        const request: awsCloudFormation.CreateChangeSetInput = {
            ChangeSetName: taskParameters.changeSetName,
            ChangeSetType: taskParameters.changeSetType,
            StackName: taskParameters.stackName,
            Parameters: templateParameters,
            TemplateBody: template,
            Description: taskParameters.description,
            NotificationARNs: taskParameters.notificationARNs,
            ResourceTypes: taskParameters.resourceTypes,
            RoleARN: taskParameters.roleARN
        };

        return await this.createChangeSetFromRequest(request);
    }

    private static async createChangeSetFromTemplateUrl(taskParameters: TaskParameters.CreateChangeSetTaskParameters) : Promise<string> {
        console.log(tl.loc('CreatingChangesetFromUrls', taskParameters.cfTemplateUrl, taskParameters.cfParametersFileUrl));

        const regex: string = '(s3-|s3\.)?(.*)\.amazonaws\.com';
        const regExpression = new RegExp(regex);
        const matches = taskParameters.cfParametersFileUrl.match(regExpression);
        if (!matches) {
            throw new Error(tl.loc('UrlFormatError', regex));
        }

        const bucketUrlPos = taskParameters.cfParametersFileUrl.indexOf(matches[0]) + matches[0].length + 1;
        const bucketUrl = taskParameters.cfParametersFileUrl.slice(bucketUrlPos);
        tl.debug(`Bucket URl: ${bucketUrl}`);
        const bucketName = bucketUrl.split('/')[0];
        tl.debug(`Bucket name: ${bucketName}`);
        const fileKey = bucketUrl.slice(bucketUrl.indexOf(bucketName) + bucketName.length + 1);
        tl.debug(`Template Parameters File Key: ${fileKey}`);

        let templateParameters: any;
        try {
            const downloadResponse: awsS3.GetObjectOutput = await this.s3Client.getObject({
                Bucket: bucketName,
                Key: fileKey
            }).promise();

            templateParameters = JSON.parse(downloadResponse.Body.toString());
        } catch (err) {
            console.log(tl.loc('ParametersUrlLoadOrParseError', err.message));
            throw err;
        }

        const request: awsCloudFormation.CreateChangeSetInput = {
            ChangeSetName: taskParameters.changeSetName,
            ChangeSetType: taskParameters.changeSetType,
            StackName: taskParameters.stackName,
            Parameters: templateParameters,
            TemplateURL: taskParameters.cfTemplateUrl,
            Description: taskParameters.description,
            NotificationARNs: taskParameters.notificationARNs,
            ResourceTypes: taskParameters.resourceTypes,
            RoleARN: taskParameters.roleARN
        };

        return await this.createChangeSetFromRequest(request);
    }

    private static async executeChangeSet(changeSetName: string, stackName: string) : Promise<void> {
        console.log(tl.loc('ExecutingChangeset', changeSetName, stackName));

        try {
            await this.cloudFormationClient.executeChangeSet({
                ChangeSetName: changeSetName,
                StackName: stackName
            }).promise();

            await this.waitForStackCreation(stackName);
        } catch (err) {
            console.error(tl.loc('ExecuteChangesetFailed', err.message), err);
            throw err;
        }
    }

    private static async createChangeSetFromRequest(request: awsCloudFormation.CreateChangeSetInput) : Promise<string> {
        try {
            const response: awsCloudFormation.CreateChangeSetOutput = await this.cloudFormationClient.createChangeSet(request).promise();

            tl.debug(`Change set id ${response.Id}, stack id ${response.StackId}`);
            await this.waitForChangeSetCreation(request.ChangeSetName, response.StackId);
            return response.StackId;
        }  catch (err) {
            console.error(tl.loc('ChangesetCreationFailed', err.message), err);
            throw err;
        }
    }

    private static async waitForChangeSetCreation(changeSetName: string, stackId: string) : Promise<void> {

        return new Promise<void>((resolve, reject) => {
            console.log(tl.loc('WaitingForChangesetValidation', changeSetName));

            this.cloudFormationClient.waitFor('changeSetCreateComplete',
                                              { ChangeSetName: changeSetName, StackName: stackId },
                                              function(err: AWSError, data: awsCloudFormation.DescribeChangeSetOutput) {
                if (err) {
                    throw new Error(tl.loc('ChangesetValidationFailed', changeSetName, err.message));
                } else {
                    console.log(tl.loc('ChangesetValidated'));
                }
            });
        });
    }

    private static async waitForStackCreation(stackName: string) : Promise<void> {

        return new Promise<void>((resolve, reject) => {
            console.log(tl.loc('WaitingForChangesetExecution', stackName));

            this.cloudFormationClient.waitFor('stackCreateComplete',
                                              { StackName: stackName },
                                              function(err: AWSError, data: awsCloudFormation.DescribeStacksOutput) {
                if (err) {
                    throw new Error(tl.loc('ExecuteChangesetFailed', err.message));
                } else {
                    console.log(tl.loc('ChangesetExecuted'));
                }
            });
        });
    }

}