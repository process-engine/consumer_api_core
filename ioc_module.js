'use strict'

const {
  ConsumerApiIamService,
  ConsumerApiProcessEngineAdapter,
  ConsumerApiService,
} = require('./dist/commonjs/index');

function registerInContainer(container) {

  // Workaround until a suitable authority (identity provider) is in place.
  container.register('ConsumerApiIamService', ConsumerApiIamService)
    .configure('consumer_api_core:consumer_api_iam_service')
    .singleton();
  
  container.register('ConsumerApiProcessEngineAdapter', ConsumerApiProcessEngineAdapter)
    .dependencies('ConsumerApiIamService', 'IamService')
    .singleton();

  container.register('ConsumerApiService', ConsumerApiService)
    .dependencies('ConsumerApiProcessEngineAdapter',
                  'ExecuteProcessService',
                  'ProcessModelFacadeFactory',
                  'ProcessModelPersistance',
                  'FlowNodeInstancePersistance',
                  'EventAggregator')
    .singleton();
}

module.exports.registerInContainer = registerInContainer;
