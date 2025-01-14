/* eslint-disable no-console */
import * as core from '@actions/core';
import * as fs from 'fs';
import * as request from 'request-promise';

async function base64Encode(file: string) {
  const base64encoded = fs.readFileSync(file, { encoding: 'base64' });
  return base64encoded;
}

async function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getRequestData() {
  const username: string = core.getInput('ansible-tower-user');
  const password: string = core.getInput('ansible-tower-pass');
  const url: string = core.getInput('ansible-tower-url');
  const additionalVars = JSON.parse(core.getInput('additional-vars'));
  const templateId: string = core.getInput('template-id');
  const certPath: string = core.getInput('certificate-path');
  const scmBranch: string = core.getInput('scm-branch') ?? "";
  let certBase64 = '';
  const requestData: any = { extraVars: {}, templateId };

  console.log(`Run configured to use Tower/AWX baseurl: ${url}`);

  if (certPath) {
    certBase64 = await base64Encode(certPath);
  }

  requestData.extraVars.scm_branch = scmBranch;

  requestData.baseRequest = request.defaults({
    baseUrl: url,
    json: true,
    strictSSL: false,
    auth: {
      user: username,
      pass: password,
      sendImmediately: true,
    },
  });

  requestData.extraVars.extra_vars = {
    ...(certBase64 != '' && {
      var_applicationGatewayFrontEndSslCertData: certBase64,
    }),
  };

  Object.assign(requestData.extraVars.extra_vars, additionalVars);

  const extraVarsToPrint = { ...requestData.extraVars.extra_vars };
  if (certPath) {
    extraVarsToPrint.var_applicationGatewayFrontEndSslCertData = '*************';
  }

  console.log('extra-vars: ');
  console.log(extraVarsToPrint);

  return requestData;
}

async function launchJob(requestData: any) {
  console.log(`Launching Template ID: ${requestData.templateId}`);

  const options = {
    url: `api/v2/job_templates/${requestData.templateId}/launch/`,
    body: requestData.extraVars,
  };

  const response = await requestData.baseRequest.post(options);

  if (response && response.job) {
    console.log(`Template Id ${requestData.templateId} launched successfully.`);
    console.log(`Job ${response.job} was created on Ansible Tower: Status ${response.status}.`);
    return response.url;
  }
  if (response && response.detail) {
    console.log(
      `Template ID ${requestData.templateId} couldn't be launched, the Ansible API is returning the following error:`,
    );
    throw new Error(response.detail);
  } else {
    console.log(response);
    throw new Error(`Template ID ${requestData.templateId} couldn't be launched, the Ansible API is not working`);
  }
}

async function getFinalStatus(requestData: any, jobUrl: string) {
  const options = {
    url: jobUrl,
  };

  let response = await requestData.baseRequest.get(options);

  if (response && response.status) {
    if (!(response.status === 'failed') && !(response.status === 'successful') && !(response.status === 'error')) {
      console.log('Validating Job status...');
      await wait(10000);
      console.log(`Job status: ${response.status}.`);
      response = await getFinalStatus(requestData, jobUrl);
      return response;
    }
    return response;
  }
  if (response && response.detail) {
    console.log('Failed to get job status from Ansible Tower.');
    throw new Error(response.detail);
  } else {
    console.log(response);
    throw new Error('Failed to get job status from Ansible Tower.');
  }
}

async function printAnsibleOutput(requestData: any, jobData: any) {
  const options = {
    url: `${jobData.related.stdout}?format=txt`,
    json: false,
  };

  const response = await requestData.baseRequest.get(options);

  if (jobData.status === 'failed' && response) {
    console.log(`Final status: ${jobData.status}`);
    console.log('***************************Ansible Tower error output***************************');
    console.log(response);
    throw new Error(`Ansible tower job ${jobData.id} execution failed`);
  } else if (jobData.status === 'error') {
    console.log(`Final status: ${jobData.status}`);
    console.log('***************************Ansible Tower error output***************************');
    console.log(response);
    console.log('***************************Ansible Tower traceback output***************************');
    console.log(jobData.result_traceback);
    throw new Error(`An error has ocurred on Ansible tower trying to launch job ${jobData.id}`);
  } else if (jobData.status === 'successful' && response) {
    console.log(`Final status: ${jobData.status}`);
    console.log('******************************Ansible Tower output******************************');
    console.log(response);
  } else {
    console.log(`Final status: ${jobData.status}`);
    console.log('[warning]: An error ocurred trying to get the ansible tower output');
    console.log(response);
  }
  return response;
}

async function exportResourceName(output: string) {
  const regex = /(\/(\w+)\\)|(\/(\w+)")/g;
  const found = output.match(regex);

  if (found) {
    const resourceName = found[found.length - 1].substring(1, found[found.length - 1].length - 1);
    core.setOutput('RESOURCE_NAME', resourceName);
    console.log(`Resource name exported: ${resourceName}`);
  } else {
    console.log('[warning]: No resource name exported as output variable.');
  }
}

async function run() {
  try {
    const requestData = await getRequestData();
    const jobUrl: string = await launchJob(requestData);
    const jobData = await getFinalStatus(requestData, jobUrl);
    const output = await printAnsibleOutput(requestData, jobData);
    await exportResourceName(output);
  } catch (error) {
    console.log(error);

    if (error instanceof SyntaxError) {
      console.log(error.message);
      core.setFailed('Extra vars invalid format, please provide a valid JSON.');
    } else {
      ;
      core.setFailed("error");
    }
  }
}

run();
