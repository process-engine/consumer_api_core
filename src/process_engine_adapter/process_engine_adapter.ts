// tslint:disable:max-file-line-count
import {
  ConsumerContext,
  Event as ConsumerApiEvent,
  EventList as ConsumerApiEventList,
  EventTriggerPayload,
  IConsumerApiService,
  ICorrelationResult,
  ProcessModel as ConsumerApiProcessModel,
  ProcessModelList as ConsumerApiProcessModelList,
  ProcessStartRequestPayload,
  ProcessStartResponsePayload,
  StartCallbackType,
  UserTask,
  UserTaskConfig,
  UserTaskFormField,
  UserTaskList,
  UserTaskResult,
} from '@process-engine/consumer_api_contracts';

import {
  ExecutionContext,
  IIamService,
  IIdentity,
  IPrivateQueryOptions,
  IPublicGetOptions,
  IQueryClause,
  TokenType,
} from '@essential-projects/core_contracts';
import {IDatastoreService, IEntityCollection, IEntityType} from '@essential-projects/data_model_contracts';
import {IEventAggregator, ISubscription} from '@essential-projects/event_aggregator_contracts';
import {IDataMessage, IMessageBusService, IMessageSubscription} from '@essential-projects/messagebus_contracts';
import {
  BpmnType,
  IErrorDeserializer,
  INodeDefEntity,
  INodeInstanceEntity,
  INodeInstanceEntityTypeService,
  IProcessDefEntity,
  IProcessEngineService,
  IProcessEntity,
  IProcessTokenEntity,
  IStartEventEntity,
  IUserTaskEntity,
  IUserTaskMessageData,
  IFlowNodeInstancePersistance,
  Model,
} from '@process-engine/process_engine_contracts';

import {
  BadRequestError,
  BaseError,
  ForbiddenError,
  InternalServerError,
  isError,
  NotFoundError,
  UnprocessableEntityError,
} from '@essential-projects/errors_ts';
import * as BpmnModdle from 'bpmn-moddle';
import {MessageAction, NodeDefFormField} from './process_engine_adapter_interfaces';

import {IBpmnModdle, IDefinition, IModdleElement} from './bpmnmodeler/index';
import {ConsumerApiIamService} from './consumer_api_iam_service';

import {Logger} from 'loggerhythm';

import * as uuid from 'uuid';

const logger: Logger = Logger.createLogger('consumer_api_core')
                             .createChildLogger('process_engine_adapter');

export class ConsumerApiProcessEngineAdapter implements IConsumerApiService {
  public config: any = undefined;

  private _consumerApiIamService: ConsumerApiIamService;
  private _processEngineService: IProcessEngineService;
  private _iamService: IIamService;
  private _datastoreService: IDatastoreService;
  private _nodeInstanceEntityTypeService: INodeInstanceEntityTypeService;
  private _messageBusService: IMessageBusService;
  private _errorDeserializer: IErrorDeserializer;
  private _eventAggregator: IEventAggregator;
  private _processEngineStorageService: IProcessEngineStorageService;
  private _flowNodeInstancePersistance: IFlowNodeInstancePersistance;

  constructor(consumerApiIamService: ConsumerApiIamService,
              datastoreService: IDatastoreService,
              eventAggregator: IEventAggregator,
              iamService: IIamService,
              messageBusService: IMessageBusService,
              nodeInstanceEntityTypeService: INodeInstanceEntityTypeService,
              processEngineService: IProcessEngineService,
              processEngineStorageService: IProcessEngineStorageService,
              flowNodeInstancePersistance: IFlowNodeInstancePersistance) {

    this._consumerApiIamService = consumerApiIamService;
    this._datastoreService = datastoreService;
    this._eventAggregator = eventAggregator;
    this._iamService = iamService;
    this._messageBusService = messageBusService;
    this._nodeInstanceEntityTypeService = nodeInstanceEntityTypeService;
    this._processEngineService = processEngineService;
    this._processEngineStorageService = processEngineStorageService;
    this._flowNodeInstancePersistance = flowNodeInstancePersistance;
  }

  private get consumerApiIamService(): ConsumerApiIamService {
    return this._consumerApiIamService;
  }

  private get datastoreService(): IDatastoreService {
    return this._datastoreService;
  }

  private get errorDeserializer(): IErrorDeserializer {
    return this._errorDeserializer;
  }

  private get eventAggregator(): IEventAggregator {
    return this._eventAggregator;
  }

  private get messageBusService(): IMessageBusService {
    return this._messageBusService;
  }

  private get nodeInstanceEntityTypeService(): INodeInstanceEntityTypeService {
    return this._nodeInstanceEntityTypeService;
  }

  private get processEngineIamService(): IIamService {
    return this._iamService;
  }

  private get processEngineService(): IProcessEngineService {
    return this._processEngineService;
  }

  private get processEngineStorageService(): IProcessEngineStorageService {
    return this._processEngineStorageService;
  }

  private get flowNodeInstancePersistance(): IFlowNodeInstancePersistance {
    return this._flowNodeInstancePersistance;
  }

  public async initialize(): Promise<void> {
    this._initializeDefaultErrorDeserializer();

    return Promise.resolve();
  }

  private _initializeDefaultErrorDeserializer(): void {
    const defaultDeserializer: IErrorDeserializer = (serializedError: string): Error => {

      if (typeof serializedError !== 'string') {
        return serializedError;
      }

      try {
        return BaseError.deserialize(serializedError);
      } catch (error) {
        logger.error('an error occured deserializing this error: ', serializedError);
        throw new Error('an error occured during error deserialization');
      }

    };
    this._errorDeserializer = defaultDeserializer;
  }

  // Process models
  public async getProcessModels(context: ConsumerContext): Promise<ConsumerApiProcessModelList> {

    const executionContext: ExecutionContext = await this._createExecutionContextFromConsumerContext(context);

    const processModels: Array<IProcessDefEntity> = await this._getProcessModels(executionContext);

    const result: Array<ConsumerApiProcessModel> = [];
    for (const processModel of processModels) {

      try {
        const mappedProcessModel: ConsumerApiProcessModel = await this.getProcessModelByKey(context, processModel.key);
        result.push(mappedProcessModel);
      } catch (error) {
        // if we're not allowed to access that process model, then thats fine. In that case, every startevent is invisible to us,
        // but this sould not make fetching startevents from other instances fail
        if (!isError(error, ForbiddenError)) {
          throw error;
        }
      }
    }

    return {
      process_models: result,
    };
  }

  public async getProcessModelByKey(context: ConsumerContext, processModelKey: string): Promise<ConsumerApiProcessModel> {

    const executionContext: ExecutionContext = await this._createExecutionContextFromConsumerContext(context);

    const processDef: IProcessDefEntity = await this._getProcessModelByKey(executionContext, processModelKey);

    let accessibleStartEventEntities: Array<INodeDefEntity> = await this._getAccessibleStartEvents(executionContext, processModelKey);

    if (accessibleStartEventEntities.length === 0) {
      throw new ForbiddenError(`Access to Process Model '${processModelKey}' not allowed`);
    }

    // This is a completely different use case and must therefore happen AFTER the IAM check!
    if (!processDef.isExecutable) {
      accessibleStartEventEntities = [];
    }

    const startEventMapper: any = (startEventEntity: INodeDefEntity): ConsumerApiEvent => {
      const consumerApiStartEvent: ConsumerApiEvent = {
        key: startEventEntity.key,
        id: startEventEntity.id,
        process_instance_id: undefined,
        data: startEventEntity.startContext,
      };

      return consumerApiStartEvent;
    };

    const mappedStartEvents: Array<ConsumerApiEvent> = accessibleStartEventEntities.map(startEventMapper);

    const processModel: ConsumerApiProcessModel = {
      key: processDef.key,
      startEvents: mappedStartEvents,
    };

    return processModel;
  }

  public async startProcessInstance(context: ConsumerContext,
                                    processModelKey: string,
                                    startEventKey: string,
                                    payload: ProcessStartRequestPayload,
                                    startCallbackType: StartCallbackType,
                                  ): Promise<ProcessStartResponsePayload> {

    const executionContext: ExecutionContext = await this._createExecutionContextFromConsumerContext(context);

    const processModel: IProcessDefEntity = await this._getProcessModelByKey(executionContext, processModelKey);

    if (!processModel.isExecutable) {
      throw new BadRequestError(`The Process Model '${processModelKey}' is not executable!`);
    }

    const startEventEntity: INodeDefEntity = await this._getStartEventEntity(executionContext, processModelKey, startEventKey);

    let correlationId: string;

    const processInstanceId: string = await this.processEngineService.createProcessInstance(executionContext, undefined, processModelKey);

    if (startCallbackType === StartCallbackType.CallbackOnProcessInstanceCreated) {
      correlationId = await this._startProcessInstance(executionContext, processModelKey, payload);
    } else {
      correlationId = await this._startProcessInstanceAndAwaitEndEvent(executionContext, processInstanceId, startEventEntity, undefined, payload);
    }

    const response: ProcessStartResponsePayload = {
      correlation_id: correlationId,
    };

    return response;
  }

  public async startProcessInstanceAndAwaitEndEvent(context: ConsumerContext,
                                                    processModelKey: string,
                                                    startEventKey: string,
                                                    endEventKey: string,
                                                    payload: ProcessStartRequestPayload,
                                                  ): Promise<ProcessStartResponsePayload> {

    const executionContext: ExecutionContext = await this._createExecutionContextFromConsumerContext(context);

    const processModel: IProcessDefEntity = await this._getProcessModelByKey(executionContext, processModelKey);

    if (!processModel.isExecutable) {
      throw new BadRequestError(`The Process Model '${processModelKey}' is not executable!`);
    }

    const startEventEntity: INodeDefEntity = await this._getStartEventEntity(executionContext, processModelKey, startEventKey);
    const endEventEntity: INodeDefEntity = await this._getEndEventEntity(executionContext, processModelKey, endEventKey);

    const processInstanceId: string = await this.processEngineService.createProcessInstance(executionContext, undefined, processModelKey);

    const correlationId: string =
      await this._startProcessInstanceAndAwaitEndEvent(executionContext, processInstanceId, startEventEntity, endEventEntity.key, payload);

    const response: ProcessStartResponsePayload = {
      correlation_id: correlationId,
    };

    return response;
  }

  public async getProcessResultForCorrelation(context: ConsumerContext,
                                              correlationId: string,
                                              processModelKey: string): Promise<ICorrelationResult> {

    const executionContext: ExecutionContext = await this._createExecutionContextFromConsumerContext(context);

    const process: IProcessEntity = await this._getFinishedProcessInstanceInCorrelation(executionContext, correlationId, processModelKey);

    const processInstanceResult: ICorrelationResult = await this._getProcessInstanceResult(executionContext, process.id);

    return processInstanceResult;
  }

  // Events
  public async getEventsForProcessModel(context: ConsumerContext, processModelKey: string): Promise<ConsumerApiEventList> {

    const mockData: ConsumerApiEventList = {
      events: [{
        key: 'startEvent_1',
        id: '',
        process_instance_id: '',
        data: {},
      }],
    };

    return Promise.resolve(mockData);
  }

  public async getEventsForCorrelation(context: ConsumerContext, correlationId: string): Promise<ConsumerApiEventList> {

    const mockData: ConsumerApiEventList = {
      events: [{
        key: 'startEvent_1',
        id: '',
        process_instance_id: '',
        data: {},
      }],
    };

    return Promise.resolve(mockData);
  }

  public async getEventsForProcessModelInCorrelation(context: ConsumerContext,
                                                     processModelKey: string,
                                                     correlationId: string): Promise<ConsumerApiEventList> {

    const mockData: ConsumerApiEventList = {
      events: [{
        key: 'startEvent_1',
        id: '',
        process_instance_id: '',
        data: {},
      }],
    };

    return Promise.resolve(mockData);
  }

  public async triggerEvent(context: ConsumerContext,
                            processModelKey: string,
                            correlationId: string,
                            eventId: string,
                            eventTriggerPayload?: EventTriggerPayload): Promise<void> {
    return Promise.resolve();
  }

  // UserTasks
  public async getUserTasksForProcessModel(context: ConsumerContext, processModelKey: string): Promise<UserTaskList> {
    const executionContext: ExecutionContext = await this._createExecutionContextFromConsumerContext(context);

    const userTasks: Array<IUserTaskEntity> = await this._getAccessibleUserTasksForProcessModel(executionContext, processModelKey);
    
    const userTaskList: UserTaskList = userTasks.map((userTask) => {
      return userTask.formFields;
    });

    return {
      user_tasks: userTaskList,
    };
  }

  public async getUserTasksForCorrelation(context: ConsumerContext, correlationId: string): Promise<UserTaskList> {
    const executionContext: ExecutionContext = await this._createExecutionContextFromConsumerContext(context);

    const processModelsInCorrelation: Array<string> = await this._getProcessModelKeysForCorrelation(executionContext, correlationId);
    let accessibleLaneIds: Array<string> = [];
    for (const processModelKey of processModelsInCorrelation) {
      // tslint:disable-next-line:max-line-length
      const accessibleLanesInThisProcess: Array<string> = await this._getIdsOfLanesThatCanBeAccessed(executionContext, processModelKey);
      accessibleLaneIds = accessibleLaneIds.concat(accessibleLanesInThisProcess);
    }

    if (accessibleLaneIds.length === 0) {
      throw new ForbiddenError(`Access to correlation '${correlationId}' not allowed`);
    }

    const userTasks: Array<IUserTaskEntity> = await this._getUserTasksForCorrelation(executionContext, correlationId);
    
    return this._userTaskEntitiesToUserTaskList(context, userTasks);
  }

  public async getUserTasksForProcessModelInCorrelation(context: ConsumerContext,
                                                        processModelId: string,
                                                        correlationId: string): Promise<UserTaskList> {
    const executionContext: ExecutionContext = await this._createExecutionContextFromConsumerContext(context);

    if (!await this._processModelBelongsToCorrelation(executionContext, correlationId, processModelId)) {
      throw new NotFoundError(`ProcessModel with key '${processModelId}' is not part of the correlation with id '${correlationId}'`);
    }

    const accessibleLaneIds: Array<string> = await this._getIdsOfLanesThatCanBeAccessed(executionContext, processModelId);

    if (accessibleLaneIds.length === 0) {
      throw new ForbiddenError(`Access to Process Model '${processModelId}' not allowed`);
    }

    const userTasks: Array<Model.Activities.UserTask> = await this._getUserTasksForCorrelation(executionContext, correlationId);
    const processDefinition: Model.Types.Process = await this.processEngineStorageService.getProcess(processModelId);
    const processUserTasks: Array<Model.Activities.UserTask> = this._getUserTasks(processDefinition);

    const allProcessInstances: Array<Runtime.Types.ProcessInstance> = await this.processEngineStorageService.getProcessInstancesForCorrelation(correlationId);
    const userTaskProcessInstance: Runtime.Types.ProcessInstance = allProcessInstances.find((processInstance) => {
      return processInstance.processDefinition.id === processModelId;
    });

    if (!userTaskProcessInstance) {
      throw new Error(`ProcessInstance for ProcessModel with key '${processModelId}' and correlation with id '${correlationId}' could not be found.`);
    }

    const userTasksForProcessModel: Array<Model.Activities.UserTask> = userTasks.filter((userTask: Model.Activities.UserTask) => {
      return processUserTasks.some((processUserTask) => {
        return processUserTask.id === userTask.id;
      });
    });

    const userTaskList: UserTaskList = userTasks.map((userTask) => {
      return {
        id: userTask.id, // TODO: guess this should be the flow node instance id
        key: userTask.id,
        data: userTask.formFields,
        processInstanceId: userTaskProcessInstance.id,
      };
    });

    return {
      user_tasks: userTaskList,
    };
  }

  public async finishUserTask(context: ConsumerContext,
                              processModelId: string,
                              correlationId: string,
                              userTaskId: string,
                              userTaskResult: UserTaskResult): Promise<void> {

    const executionContext: ExecutionContext = await this._createExecutionContextFromConsumerContext(context);

    const userTasks: UserTaskList = await this.getUserTasksForProcessModelInCorrelation(context, processModelId, correlationId);

    const userTask: UserTask = userTasks.user_tasks.find((task: UserTask) => {
      return task.key === userTaskId;
    });

    if (userTask === undefined) {
      throw new NotFoundError(`Process model '${processModelId}' in correlation '${correlationId}' does not have a user task '${userTaskId}'`);
    }

    const resultForProcessEngine: any = this._getUserTaskResultFromUserTaskConfig(userTaskResult);

    return new Promise<void>((resolve: Function, reject: Function): void => {
      const subscription: ISubscription = this.eventAggregator.subscribe(`/processengine/node/${userTask.id}`, (event: any) => {
        subscription.dispose();
        resolve();
      });

      this.eventAggregator.publish(`/processengine/node/${userTask.id}`, {
        data: {
          action: MessageAction.proceed,
          token: resultForProcessEngine,
        },
        metadata: {
          context: executionContext,
        },
      });
    });
  }

  // -------------
  // Process Engine Accessor Functions. Here be dragons. With lasers.
  // -------------

  private _createExecutionContextFromConsumerContext(consumerContext: ConsumerContext): Promise<ExecutionContext> {
    return this.processEngineIamService.resolveExecutionContext(consumerContext.identity, TokenType.jwt);
  }

  private async _getProcessModels(executionContext: ExecutionContext): Promise<Array<IProcessDefEntity>> {
    const processDefEntityType: IEntityType<IProcessDefEntity> = await this.datastoreService.getEntityType<IProcessDefEntity>('ProcessDef');
    const processDefCollection: IEntityCollection<IProcessDefEntity> = await processDefEntityType.all(executionContext);

    const processModels: Array<IProcessDefEntity> = [];
    await processDefCollection.each(executionContext, (processModel: IProcessDefEntity) => {
      processModels.push(processModel);
    });

    return processModels;
  }

  private async _getProcessModelByKey(executionContext: ExecutionContext, processModelKey: string): Promise<IProcessDefEntity> {

    const queryOptions: IPrivateQueryOptions = {
      query: {
        attribute: 'key',
        operator: '=',
        value: processModelKey,
      },
    };

    const processDefEntityType: IEntityType<IProcessDefEntity> = await this.datastoreService.getEntityType<IProcessDefEntity>('ProcessDef');
    const processDef: IProcessDefEntity = await processDefEntityType.findOne(executionContext, queryOptions);

    if (!processDef) {
      throw new NotFoundError(`Process model with key ${processModelKey} not found.`);
    }

    return processDef;
  }

  private async _getStartEventEntity(executionContext: ExecutionContext, processModelKey: string, startEventKey: string): Promise<INodeDefEntity> {

    const accessibleStartEventEntities: Array<INodeDefEntity> = await this._getAccessibleStartEvents(executionContext, processModelKey);

    const matchingStartEvent: INodeDefEntity = accessibleStartEventEntities.find((entity: INodeDefEntity): boolean => {
      return entity.key === startEventKey;
    });

    if (!matchingStartEvent) {
      throw new NotFoundError(`Start event ${startEventKey} not found.`);
    }

    return matchingStartEvent;
  }

  private async _getEndEventEntity(executionContext: ExecutionContext, processModelKey: string, endEventKey: string): Promise<INodeDefEntity> {

    const accessibleEndEventEntities: Array<INodeDefEntity> = await this._getAccessibleEndEvents(executionContext, processModelKey);

    const matchingEndEvent: INodeDefEntity = accessibleEndEventEntities.find((entity: INodeDefEntity): boolean => {
      return entity.key === endEventKey;
    });

    if (!matchingEndEvent) {
      throw new NotFoundError(`End event ${endEventKey} not found.`);
    }

    return matchingEndEvent;
  }

  private async _getAccessibleStartEvents(executionContext: ExecutionContext, processModelKey: string): Promise<Array<INodeDefEntity>> {

    const startEvents: Array<INodeDefEntity> = await this._getStartEventsForProcessModel(executionContext, processModelKey);
    const accessibleStartEventEntities: Array<INodeDefEntity> = await this._filterAccessibleEvents(executionContext, processModelKey, startEvents);

    return accessibleStartEventEntities;
  }

  private async _getAccessibleEndEvents(executionContext: ExecutionContext, processModelKey: string): Promise<Array<INodeDefEntity>> {

    const endEvents: Array<INodeDefEntity> = await this._getEndEventsForProcessModel(executionContext, processModelKey);
    const accessibleEndEventEntities: Array<INodeDefEntity> = await this._filterAccessibleEvents(executionContext, processModelKey, endEvents);

    return accessibleEndEventEntities;
  }

  private async _getStartEventsForProcessModel(executionContext: ExecutionContext, processModelKey: string): Promise<Array<INodeDefEntity>> {
    return this._getNodesByTypeForProcessModel(executionContext, processModelKey, BpmnType.startEvent);
  }

  private async _getEndEventsForProcessModel(executionContext: ExecutionContext, processModelKey: string): Promise<Array<INodeDefEntity>> {
    return this._getNodesByTypeForProcessModel(executionContext, processModelKey, BpmnType.endEvent);
  }

  private async _filterAccessibleEvents(executionContext: ExecutionContext,
                                        processModelKey: string,
                                        events: Array<INodeDefEntity>): Promise<Array<INodeDefEntity>> {

    const accessibleLaneIds: Array<string> = await this._getIdsOfLanesThatCanBeAccessed(executionContext, processModelKey);

    if (accessibleLaneIds.length === 0) {
      throw new ForbiddenError(`Access to Process Model '${processModelKey}' not allowed`);
    }

    const processModel: IProcessDefEntity = await this._getProcessModelByKey(executionContext, processModelKey);
    const processDefinitions: IDefinition = await this._getDefinitionsFromProcessModel(processModel);

    const accessibleEventEntities: Array<any> = events.filter((event: INodeDefEntity) => {
      const laneId: string = this._getLaneIdForElement(processDefinitions, event.key);
      const identityCanAccessEvent: boolean = laneId !== undefined && accessibleLaneIds.includes(laneId);

      return identityCanAccessEvent;
    });

    if (accessibleEventEntities.length === 0) {
      throw new ForbiddenError(`Access to Process Model '${processModelKey}' not allowed`);
    }

    return accessibleEventEntities;
  }

  // Manually implements "IProcessEntity.start()"
  private async _startProcessInstance(context: ExecutionContext,
                                      processModelKey: string,
                                      payload: ProcessStartRequestPayload): Promise<string> {

    const internalContext: ExecutionContext = await this.processEngineIamService.createInternalContext('processengine_system');

    const correlationId: string = payload.correlation_id || uuid.v4();

    // don't use await so that it doesn't wait for the process execution to finish
    this.processEngineService.executeProcess(internalContext, undefined, processModelKey, payload.input_values, undefined, correlationId);

    return correlationId;
  }

  // Pretty much the same as the private function of the process engine service with the same name,
  //  except that it only resolves on a specific end event.
  private _startProcessInstanceAndAwaitEndEvent(executionContext: ExecutionContext,
                                                processInstanceId: string,
                                                startEventEntity: INodeDefEntity,
                                                endEventToWaitFor: string,
                                                payload: ProcessStartRequestPayload): Promise<any> {

    return new Promise(async(resolve: Function, reject: Function): Promise<void> => {

      let correlationId: string;

      const processInstanceChannel: string = `/processengine/process/${processInstanceId}`;
      const processEndSubscription: IMessageSubscription = await this.messageBusService.subscribe(processInstanceChannel, (message: IDataMessage) => {

        if (message.data.event === 'error') {

          if (!this.errorDeserializer) {
            logger.error('No error deserializer has been set!');
            logger.error(message.data);
            throw new Error(message.data.data);
          }

          const deserializedError: Error = this.errorDeserializer(message.data.data);
          logger.error('The process failed with an error.', deserializedError.message);

          // The requester may not be allowed to know why the process terminated
          reject(new InternalServerError('The process failed with an error.'));
          processEndSubscription.cancel();

          return;
        }

        if (message.data.event === 'terminate') {
          logger.warn(`Unexpected process termination through TerminationEndEvent '${message.data.endEventKey}'!`);

          return reject(new InternalServerError(`The process was terminated through the '${message.data.endEventKey}' TerminationEndEvent!`));
        }

        if (message.data.event !== 'end') {
          return;
        }

        logger.info(`Reached EndEvent '${message.data.endEventKey}'`);

        if (!endEventToWaitFor || (message.data.endEventKey === endEventToWaitFor)) {
          processEndSubscription.cancel();

          return resolve(correlationId);
        }

        return;
      });

      correlationId = await this._startProcessInstance(executionContext, processInstanceId, startEventEntity, payload);
    });
  }

  private async _getFinishedProcessInstanceInCorrelation(executionContext: ExecutionContext,
                                                         correlationId: string,
                                                         processModelKey: string): Promise<IProcessEntity> {

    const processInstanceQueryOptions: IPrivateQueryOptions = {
      query: {
        operator: 'and',
        queries: [{
          attribute: 'correlationId',
          operator: '=',
          value: correlationId,
        }, {
          attribute: 'key',
          operator: '=',
          value: processModelKey,
        }, {
          attribute: 'status',
          operator: '=',
          value: 'end',
        }],
      },
    };

    const processEntityType: IEntityType<IProcessEntity> = await this.datastoreService.getEntityType<IProcessEntity>('Process');
    const process: IProcessEntity = await processEntityType.findOne(executionContext, processInstanceQueryOptions);

    if (!process) {
      throw new NotFoundError(`No matching finished process instance within correlation '${correlationId}' found`);
    }

    return process;
  }

  private async _getProcessInstanceResult(executionContext: ExecutionContext, processInstanceId: string): Promise<any> {

    const tokenQueryOptions: IPrivateQueryOptions = {
      query: {
        attribute: 'process',
        operator: '=',
        value: processInstanceId,
      },
    };

    const processTokenEntityType: IEntityType<IProcessTokenEntity> = await this.datastoreService.getEntityType<IProcessTokenEntity>('ProcessToken');
    const processToken: IProcessTokenEntity = await processTokenEntityType.findOne(executionContext, tokenQueryOptions);

    if (!(processToken && processToken.data && processToken.data.current)) {
      return {};
    }

    return processToken.data.current;
  }

  private async _getAccessibleUserTasksForProcessModel(executionContext: ExecutionContext, processModelKey: string): Promise<Array<Model.Activities.UserTask>> {

    const userTasks: Array<IUserTaskEntity> = await this._getUserTasksForProcessModel(executionContext, processModelKey);
    const accessibleLaneIds: Array<string> = await this._getIdsOfLanesThatCanBeAccessed(executionContext, processModelKey);

    if (accessibleLaneIds.length === 0) {
      throw new ForbiddenError(`Access to Process Model '${processModelKey}' not allowed`);
    }

    const processModel: IProcessDefEntity = await this._getProcessModelByKey(executionContext, processModelKey);
    const processDefinitions: IDefinition = await this._getDefinitionsFromProcessModel(processModel);

    return userTasks;

    // TODO: complete lane check - this is currently skipped due to having a first PoC of how the user tasks are handled

    // const accessibleUserTaskEntities: Array<any> = userTasks.filter((userTask: IUserTaskEntity) => {
    //   const laneId: string = this._getLaneIdForElement(processDefinitions, userTask.key);
    //   const identityCanAccessUserTask: boolean = laneId !== undefined && accessibleLaneIds.includes(laneId);

    //   return identityCanAccessUserTask;
    // });

    // return accessibleUserTaskEntities;
  }

  private async _userTaskEntitiesToUserTaskList(executionContext: ExecutionContext, userTasks: Array<Model.Activities.UserTask>): Promise<UserTaskList> {
    const resultUserTaskPromises: Array<any> = userTasks.map(async(userTask: Model.Activities.UserTask) => {

      // const userTaskData: any = await userTask.getUserTaskData(executionContext);

      return {
        key: userTask.id,
        // TODO (SM): the id here should be the flow node instance id
        //            -> skipping for now
        id: userTask.id, 
        // TODO (SM): the process instance id is not accessible and we would need to reflect via the user task model
        //            -> skipping for now
        // process_instance_id: userTask.process.id,
        // TODO: 'data' currently contains the response body equals that of the old consumer client.
        // The consumer api concept has no response body defined yet, however, so there MAY be discrepancies.
        // TODO (SM): deactivated the 'data' for now, since it doesn't seem to be needed
        // data: this._getUserTaskConfigFromUserTaskData(userTaskData, userTask.key),
      };
    });

    const result: UserTaskList = {
      user_tasks: await Promise.all(resultUserTaskPromises),
    };

    return result;


    const allProcessInstances: Array<Runtime.Types.ProcessInstance> = await this.processEngineStorageService.getProcessInstancesForCorrelation(correlationId);
    const userTaskProcessInstance: Runtime.Types.ProcessInstance = allProcessInstances.find((processInstance) => {
      return processInstance.processDefinition.id === processModelId;
    });

    if (!userTaskProcessInstance) {
      throw new Error(`ProcessInstance for ProcessModel with key '${processModelId}' and correlation with id '${correlationId}' could not be found.`);
    }

    const userTasksForProcessModel: Array<Model.Activities.UserTask> = userTasks.filter((userTask: Model.Activities.UserTask) => {
      return processUserTasks.some((processUserTask) => {
        return processUserTask.id === userTask.id;
      });
    });

    const userTaskList: UserTaskList = userTasks.map((userTask) => {
      return {
        id: userTask.id, // TODO: guess this should be the flow node instance id
        key: userTask.id,
        data: userTask.formFields,
        processInstanceId: userTaskProcessInstance.id,
      };
    });

    return {
      user_tasks: userTaskList,
    };





  }

  private async _getUserTasksForCorrelation(executionContext: ExecutionContext, correlationId: string): Promise<Array<IUserTaskEntity>> {
    const processInstances: Array<IProcessEntity> = await this._getProcessInstancesForCorrelation(executionContext, correlationId);

    let userTasks: Array<IUserTaskEntity> = [];
    for (const processInstance of processInstances) {
      try {
        // tslint:disable-next-line:max-line-length
        const userTasksForProcessInstance: Array<IUserTaskEntity> = await this._getAccessibleUserTasksForProcessInstance(executionContext, processInstance);
        userTasks = userTasks.concat(userTasksForProcessInstance);
      } catch (error) {
        // if we're not allowed to access that process instance, then thats fine. In that case, every usertask is invisible to us,
        // but this sould not make fetching usertasks from other instances fail
        if (!isError(error, ForbiddenError)) {
          throw error;
        }
      }
    }

    return userTasks;
  }

  private async _getAccessibleUserTasksForProcessInstance(executionContext: ExecutionContext,
                                                          processInstance: Runtime.Types.ProcessInstance): Promise<Array<Model.Activities.UserTask>> {

    const userTasks: Array<IUserTaskEntity> = await this._getUserTasksForProcessInstance(executionContext, processInstance);
    const accessibleLaneIds: Array<string> = await this._getIdsOfLanesThatCanBeAccessed(executionContext, processInstance.processDefinition.id);

    if (accessibleLaneIds.length === 0) {
      throw new ForbiddenError(`Access to Process Model '${processInstance.processDef.key}' not allowed`);
    }

    return userTasks;

    // TODO: complete lane check - this is currently skipped due to having a first PoC of how the user tasks are handled

    // const processDefinitions: IDefinition = await this._getDefinitionsFromProcessModel(processInstance.processDef);

    // const accessibleUserTaskEntities: Array<any> = userTasks.filter((userTask: IUserTaskEntity) => {
    //   const laneId: string = this._getLaneIdForElement(processDefinitions, userTask.key);
    //   const identityCanAccessUserTask: boolean = laneId !== undefined && accessibleLaneIds.includes(laneId);

    //   return identityCanAccessUserTask;
    // });

    // return accessibleUserTaskEntities;
  }

  private async _getProcessInstancesForCorrelation(executionContext: ExecutionContext, correlationId: string): Promise<Array<Runtime.Types.ProcessInstance>> {
    return this.processEngineStorageService.getProcessInstancesForCorrelation(correlationId);
  }

  private async _getSubProcessInstances(executionContext: ExecutionContext, parentProcessInstanceId: string): Promise<Array<IProcessEntity>> {

    const nodes: Array<INodeInstanceEntity> = await this._getCallActivitiesForProcessInstance(executionContext, parentProcessInstanceId);
    const nodeIds: Array<string> = nodes.map((node: INodeInstanceEntity) => {
      return node.id;
    });

    const processes: Array<IProcessEntity> = await this._getCalledProcessesViaCallerIds(executionContext, nodeIds);

    let result: Array<IProcessEntity> = processes.slice(0);
    for (const process of processes) {
      const subProcesses: Array<IProcessEntity> = await this._getSubProcessInstances(executionContext, process.id);
      result = result.concat(subProcesses);
    }

    return result;
  }

  private async _getCallActivitiesForProcessInstance(executionContext: ExecutionContext,
                                                     processInstanceId: string): Promise<Array<INodeInstanceEntity>> {
    const queryOptions: IPrivateQueryOptions = {
      query: {
        operator: 'and',
        queries: [
          {
            attribute: 'process',
            operator: '=',
            value: processInstanceId,
          },
          {
            attribute: 'type',
            operator: '=',
            value: BpmnType.callActivity,
          },
        ],
      },
    };

    const nodeDefEntityType: IEntityType<INodeInstanceEntity> = await this.datastoreService.getEntityType<INodeInstanceEntity>('NodeInstance');
    const nodeInstanceCollection: IEntityCollection<INodeInstanceEntity> = await nodeDefEntityType.query(executionContext, queryOptions);

    const nodes: Array<INodeInstanceEntity> = [];
    await nodeInstanceCollection.each(executionContext, (nodeInstance: INodeInstanceEntity) => {
      nodes.push(nodeInstance);
    });

    return nodes;
  }

  private async _getCalledProcessesViaCallerIds(executionContext: ExecutionContext, callerIds: Array<string>): Promise<Array<IProcessEntity>> {
    if (callerIds.length === 0) {
      return Promise.resolve([]);
    }

    const processInstanceQueryParts: Array<IQueryClause> = callerIds.map((callerId: string): IQueryClause => {
      return {
        attribute: 'callerId',
        operator: '=',
        value: callerId,
      };
    });

    const processInstanceQueryOptions: IPrivateQueryOptions = {
      query: {
        operator: 'or',
        queries: processInstanceQueryParts,
      },
      expandCollection: [{attribute: 'processDef'}],
    };

    const processEntityType: IEntityType<IProcessEntity> = await this.datastoreService.getEntityType<IProcessEntity>('Process');
    const processCollection: IEntityCollection<IProcessEntity> = await processEntityType.query(executionContext, processInstanceQueryOptions);

    const processes: Array<IProcessEntity> = [];
    await processCollection.each(executionContext, (process: IProcessEntity) => {
      processes.push(process);
    });

    return processes;
  }

  private async _processModelBelongsToCorrelation(executionContext: ExecutionContext,
                                                  correlationId: string,
                                                  processModelKey: string): Promise<boolean> {

    const processModelKeys: Array<string> = await this._getProcessModelKeysForCorrelation(executionContext, correlationId);

    return processModelKeys.includes(processModelKey);
  }

  private async _getProcessModelKeysForCorrelation(executionContext: ExecutionContext, correlationId: string): Promise<Array<string>> {

    const processInstances: Array<Runtime.Types.ProcessInstance> = await this._getProcessInstancesForCorrelation(executionContext, correlationId);
    
    return processInstances.map((processInstance: Runtime.Types.ProcessInstance) => {
      return processInstance.processDefinition.id;
    })
  }

  private async _getSubProcessModelKeys(executionContext: ExecutionContext, processModelKey: string): Promise<Array<string>> {
    const callActivities: Array<INodeDefEntity> = await this._getNodesByTypeForProcessModel(executionContext, processModelKey, BpmnType.callActivity);

    let result: Array<string> = callActivities.map((callActivity: INodeDefEntity) => {
      return callActivity.subProcessKey;
    });

    for (const callActivity of callActivities) {
      result = result.concat(await this._getSubProcessModelKeys(executionContext, callActivity.subProcessKey));
    }

    return result;
  }

  private async _getProcessInstanceById(executionContext: ExecutionContext, processInstanceId: string): Promise<IProcessEntity> {
    const processInstanceQueryOptions: IPublicGetOptions = {
      expandEntity: [{attribute: 'processDef'}],
    };

    const processEntityType: IEntityType<IProcessEntity> = await this.datastoreService.getEntityType<IProcessEntity>('Process');
    const process: IProcessEntity = await processEntityType.getById(processInstanceId, executionContext, processInstanceQueryOptions);

    if (!process) {
      throw new NotFoundError(`Process instance with id ${processInstanceId} not found.`);
    }

    return process;
  }

  private async _getNodesByTypeForProcessModel(executionContext: ExecutionContext,
                                               processModelKey: string,
                                               nodeType: BpmnType): Promise<Array<INodeDefEntity>> {

    const queryOptions: IPrivateQueryOptions = {
      query: {
        operator: 'and',
        queries: [
          {
            attribute: 'processDef.key',
            operator: '=',
            value: processModelKey,
          },
          {
            attribute: 'type',
            operator: '=',
            value: nodeType,
          },
        ],
      },
      expandCollection: [
        {
          attribute: 'processDef',
          childAttributes: [
            {attribute: 'key'},
          ],
        },
      ],
    };

    const nodeDefEntityType: IEntityType<INodeDefEntity> = await this.datastoreService.getEntityType<INodeDefEntity>('NodeDef');
    const nodeDefCollection: IEntityCollection<INodeDefEntity> = await nodeDefEntityType.query(executionContext, queryOptions);

    const nodes: Array<INodeDefEntity> = [];
    await nodeDefCollection.each(executionContext, (node: INodeDefEntity) => {
      nodes.push(node);
    });

    return nodes;
  }

  private async _getIdsOfLanesThatCanBeAccessed(executionContext: ExecutionContext, processModelId: string): Promise<Array<string>> {

    const process: Model.Types.Process = await this.processEngineStorageService.getProcess(processModelId);

    const identity: IIdentity = await this.processEngineIamService.getIdentity(executionContext);

    let accessibleLanes: Array<Model.Types.LaneSet> = await this._getLanesThatCanBeAccessed(identity, process.laneSet);

    return accessibleLanes.map((lane: IModdleElement) => {
      return lane.id;
    });
  }

  private async _getLanesThatCanBeAccessed(identity: IIdentity, laneSet: Model.Types.LaneSet): Promise<Array<IModdleElement>> {
    if (laneSet === undefined) {
      return Promise.resolve([]);
    }

    let result: Array<Model.Types.LaneSet> = [];

    for (const lane of laneSet.lanes) {
      const claimIsInvalid: boolean = lane.name === undefined || lane.name === '';
      if (claimIsInvalid) {
        logger.warn(`lane with id ${lane.id} has no claim/title`);
        continue;
      }

      const identityHasClaim: boolean = await this.consumerApiIamService.hasClaim(identity, lane.name);
      if (!identityHasClaim) {
        continue;
      }

      result.push(lane);
      result = result.concat(await this._getLanesThatCanBeAccessed(identity, lane.childLaneSet));
    }

    return result;
  }

  private _getDefinitionsFromProcessModel(processModel: IProcessDefEntity): Promise<IDefinition> {
    return new Promise((resolve: Function, reject: Function): void => {

      const moddle: IBpmnModdle = BpmnModdle();
      moddle.fromXML(processModel.xml, (error: Error, definitions: IDefinition) => {
        if (error) {
          return reject(error);
        }

        return resolve(definitions);
      });
    });
  }

  private _getLaneIdForElement(processDefinitions: IDefinition, elementId: string): string {
    for (const rootElement of processDefinitions.rootElements) {
      if (rootElement.$type !== 'bpmn:Process') {
        continue;
      }

      if (!rootElement.laneSets) {
        continue;
      }

      for (const laneSet of rootElement.laneSets) {
        const closestLaneId: string = this._getClosestLaneIdToElement(laneSet, elementId);
        if (closestLaneId !== undefined) {
          return closestLaneId;
        }
      }
    }
  }

  private _getClosestLaneIdToElement(laneSet: IModdleElement, elementId: string): string {
    for (const lane of laneSet.lanes) {
      if (lane.childLaneSet !== undefined) {
        return this._getClosestLaneIdToElement(lane.childLaneSet, elementId);
      }

      if (lane.flowNodeRef === undefined) {
        continue;
      }

      const elementIsInLane: boolean = lane.flowNodeRef.some((flowNode: IModdleElement) => {
        return flowNode.id === elementId;
      });

      if (elementIsInLane) {
        return lane.id;
      }
    }
  }

  private async _getUserTasksForProcessModel(executionContext: ExecutionContext, processModelKey: string): Promise<Array<IUserTaskEntity>> {

    const userTaskEntityType: IEntityType<IUserTaskEntity> = await this.datastoreService.getEntityType<IUserTaskEntity>('UserTask');

    const query: IPrivateQueryOptions = {
      query: {
        operator: 'and',
        queries: [
          {
            attribute: 'process.processDef.key',
            operator: '=',
            value: processModelKey,
          },
          {
            attribute: 'state',
            operator: '=',
            value: 'wait',
          },
        ],
      },
      expandCollection: [
        {attribute: 'processToken'},
        {
          attribute: 'nodeDef',
          childAttributes: [
            {attribute: 'lane'},
            {attribute: 'extensions'},
          ],
        },
        {
          attribute: 'process',
          childAttributes: [
            {attribute: 'id'},
          ],
        },
      ],
    };

    const userTaskCollection: IEntityCollection<IUserTaskEntity> = await userTaskEntityType.query(executionContext, query);
    const userTasks: Array<IUserTaskEntity> = [];
    await userTaskCollection.each(executionContext, (userTask: IUserTaskEntity) => {
      userTasks.push(userTask);
    });

    return userTasks;
  }

  private async _getUserTasksForProcessInstance(executionContext: ExecutionContext, processInstance: Runtime.Types.ProcessInstance): Promise<Array<Model.Activities.UserTask>> {

    const allUserTasks: Array<Model.Activities.UserTask> = this._getUserTasks(processInstance.processDefinition);

    const allFlowNodeInstances: Array<Runtime.Types.FlowNodeInstance> = await this.flowNodeInstancePersistance.querySuspended(processInstance.id);

    return allUserTasks.filter((userTask) => {
      return allFlowNodeInstances.some((flowNodeInstance) => {
        return flowNodeInstance.flowNodeId === userTask.id;
      });
    });

    // const suspendedUserTasks: Array<Model.Activities.UserTask> = allFlowNodeInstances.filter((flowNodeInstance: Runtime.Types.FlowNodeInstance) => {
    //   return flowNodeInstance instanceof Model.Activities.UserTask;
    // });

    // return suspendedUserTasks;
    // get all user tasks contained in the process model using process model facade
    // query all flow node instances from flow_node_instance_persistance
    // filter for suspended
  }

  private _getUserTasks(processDefinition: Model.Types.Process): Array<Model.Activities.UserTask> {

    const userTaskFlowNodes: Model.Base.FlowNode = processDefinition.flowNodes.filter((flowNode: Model.Base.FlowNode) => {
      return flowNode instanceof Model.Activities.UserTask;
    });
    
    const laneUserTasks: Array<Model.Activities.UserTask> = this._getUserTasksFromLaneRecursively(processDefinition.laneSet);

    const allUserTasks: Array<Model.Activities.UserTask> = [
      ...userTaskFlowNodes,
    ];

    Array.prototype.push.apply(allUserTasks, laneUserTasks);

    return allUserTasks;
  }

  private _getUserTasksFromLaneRecursively(laneSet: Model.Types.LaneSet): Array<Model.Activities.UserTask> {
    
    const userTasks: Array<Model.Activities.UserTask> = [];
    
    if (!laneSet) {
      return userTasks;
    }

    for (const lane of laneSet.lanes) {

      const userTaskFlowNodes: Model.Base.FlowNode = lane.flowNodeReferences.filter((flowNode: Model.Base.FlowNode) => {
        return flowNode instanceof Model.Activities.UserTask;
      });

      Array.prototype.push.apply(userTasks, userTaskFlowNodes);
      
      const childUserTasks = this._getUserTasksFromLaneRecursively(lane.childLaneSet);
      Array.prototype.push.apply(userTasks, childUserTasks);
    }

    return userTasks;
  }

  private _getUserTaskConfigFromUserTaskData(userTaskData: IUserTaskMessageData, userTaskKey: string): UserTaskConfig {

    const userTaskHasNoFormFields: boolean = userTaskData.userTaskEntity.nodeDef.extensions === undefined
                                          || userTaskData.userTaskEntity.nodeDef.extensions === null
                                          || userTaskData.userTaskEntity.nodeDef.extensions.formFields === undefined
                                          || userTaskData.userTaskEntity.nodeDef.extensions.formFields.length === 0;
    if (userTaskHasNoFormFields) {
      throw new UnprocessableEntityError(`UserTask with key '${userTaskKey}' has no form fields`);
    }

    const nodeDefFormFields: Array<NodeDefFormField> = userTaskData.userTaskEntity.nodeDef.extensions.formFields;
    const formFields: Array<UserTaskFormField> = nodeDefFormFields.map((processEngineFormField: NodeDefFormField) => {
      const result: UserTaskFormField = {
        id: processEngineFormField.id,
        label: processEngineFormField.label,
        type: processEngineFormField.type,
        default_value: processEngineFormField.defaultValue,
      };

      return result;
    });

    return {
      form_fields: formFields,
    };
  }

  private _getUserTaskResultFromUserTaskConfig(finishedTask: UserTaskResult): any {
    const userTaskIsNotAnObject: boolean = finishedTask === undefined
                                        || finishedTask.form_fields === undefined
                                        || typeof finishedTask.form_fields !== 'object'
                                        || Array.isArray(finishedTask.form_fields);

    if (userTaskIsNotAnObject) {
      throw new BadRequestError('The UserTasks form_fields is not an object.');
    }

    const noFormfieldsSubmitted: boolean = Object.keys(finishedTask.form_fields).length === 0;
    if (noFormfieldsSubmitted) {
      throw new BadRequestError('The UserTasks form_fields are empty.');
    }

    return finishedTask.form_fields;
  }

  private async _getMainProcessInstanceIdFromCorrelation(executionContext: ExecutionContext, correlationId: string): Promise<string> {

    const processInstanceQueryOptions: IPrivateQueryOptions = {
      query: {
        operator: 'and',
        queries: [{
          attribute: 'correlationId',
          operator: '=',
          value: correlationId,
        }],
      },
    };

    const processEntityType: IEntityType<IProcessEntity> = await this.datastoreService.getEntityType<IProcessEntity>('Process');
    const matchingProcesses: IEntityCollection<IProcessEntity> = await processEntityType.query(executionContext, processInstanceQueryOptions);

    if (!matchingProcesses.data || matchingProcesses.data.length === 0) {
      throw new NotFoundError(`correlation with id '${correlationId}' not found`);
    }

    const mainProcess: IProcessEntity = matchingProcesses.data.find((process: IProcessEntity): boolean => {
      return process.isSubProcess === false;
    });

    return mainProcess.id;
  }
}
