import {
  ExecutionContext,
  IIamService,
  TokenType,
} from '@essential-projects/core_contracts';
import * as EssentialProjectErrors from '@essential-projects/errors_ts';
import {IEventAggregator} from '@essential-projects/event_aggregator_contracts';
import {
  ConsumerContext,
  Event,
  EventList,
  EventTriggerPayload,
  IConsumerApiService,
  ICorrelationResult,
  ProcessModel,
  ProcessModelList,
  ProcessStartRequestPayload,
  ProcessStartResponsePayload,
  StartCallbackType,
  UserTask,
  UserTaskConfig,
  UserTaskFormField,
  UserTaskFormFieldType,
  UserTaskList,
  UserTaskResult,
} from '@process-engine/consumer_api_contracts';
import {IExecuteProcessService,
  IFlowNodeInstancePersistance,
  IProcessModelFacade,
  IProcessModelFacadeFactory,
  IProcessModelPersistance,
  Model,
  Runtime} from '@process-engine/process_engine_contracts';

import * as uuid from 'uuid';

export class ConsumerApiService implements IConsumerApiService {
  public config: any = undefined;

  private _executeProcessService: IExecuteProcessService;
  private _processModelFacadeFactory: IProcessModelFacadeFactory;
  private _processModelPersistance: IProcessModelPersistance;
  private _flowNodeInstancePersistance: IFlowNodeInstancePersistance;
  private _eventAggregator: IEventAggregator;
  private _iamService: IIamService;

  constructor(executeProcessService: IExecuteProcessService,
              processModelFacadeFactory: IProcessModelFacadeFactory,
              processModelPersistance: IProcessModelPersistance,
              flowNodeInstancePersistance: IFlowNodeInstancePersistance,
              eventAggregator: IEventAggregator,
              iamService: IIamService) {
    this._executeProcessService = executeProcessService;
    this._processModelFacadeFactory = processModelFacadeFactory;
    this._processModelPersistance = processModelPersistance;
    this._flowNodeInstancePersistance = flowNodeInstancePersistance;
    this._eventAggregator = eventAggregator;
    this._iamService = iamService;
  }

  private get executeProcessService(): IExecuteProcessService {
    return this._executeProcessService;
  }

  private get processModelFacadeFactory(): IProcessModelFacadeFactory {
    return this._processModelFacadeFactory;
  }

  private get processModelPersistance(): IProcessModelPersistance {
    return this._processModelPersistance;
  }

  private get flowNodeInstancePersistance(): IFlowNodeInstancePersistance {
    return this._flowNodeInstancePersistance;
  }

  private get eventAggregator(): IEventAggregator {
    return this._eventAggregator;
  }

  private get processEngineIamService(): IIamService {
    return this._iamService;
  }

  // Process models
  public async getProcessModels(context: ConsumerContext): Promise<ProcessModelList> {
    const processModels: Array<Model.Types.Process> = await this.processModelPersistance.getProcessModels();
    const consumerApiProcessModels: Array<ProcessModel> = processModels.map(this._convertToConsumerApiProcessModel);

    return <ProcessModelList> {
      processModels: consumerApiProcessModels,
    };
  }

  public async getProcessModelByKey(context: ConsumerContext, processModelKey: string): Promise<ProcessModel> {
    const processModel: Model.Types.Process = await this.processModelPersistance.getProcessModelById(processModelKey);

    const consumerApiProcessModel: ProcessModel = this._convertToConsumerApiProcessModel(processModel);

    return consumerApiProcessModel;
  }

  private _convertToConsumerApiEvent(event: Model.Events.Event): Event {

    const consumerApiEvent: Event = new Event();
    consumerApiEvent.key = event.id;
    consumerApiEvent.id = event.id;

    return consumerApiEvent;
  }

  private _convertToConsumerApiProcessModel(processModel: Model.Types.Process): ProcessModel {

    const processModelFacade: IProcessModelFacade = this.processModelFacadeFactory.create(processModel);

    const startEvents: Array<Model.Events.StartEvent> = processModelFacade.getStartEvents();
    const consumerApiStartEvents: Array<Event> = startEvents.map(this._convertToConsumerApiEvent);

    const endEvents: Array<Model.Events.EndEvent> = processModelFacade.getEndEvents();
    const consumerApiEndEvents: Array<Event> = endEvents.map(this._convertToConsumerApiEvent);

    const processModelResponse: ProcessModel = {
      key: processModel.id,
      startEvents: consumerApiStartEvents,
      endEvents: consumerApiEndEvents,
    };

    return processModelResponse;
  }

  // TODO: implement use of specific start event
  public async startProcessInstance(context: ConsumerContext,
                                    processModelId: string,
                                    startEventId: string,
                                    payload: ProcessStartRequestPayload,
                                    startCallbackType: StartCallbackType = StartCallbackType.CallbackOnProcessInstanceCreated,
                                    endEventKey?: string,
                                  ): Promise<ProcessStartResponsePayload> {

    if (!Object.values(StartCallbackType).includes(startCallbackType)) {
      throw new EssentialProjectErrors.BadRequestError(`${startCallbackType} is not a valid return option!`);
    }

    if (startCallbackType === StartCallbackType.CallbackOnEndEventReached && !endEventKey) {
      throw new EssentialProjectErrors.BadRequestError(`Must provide an EndEventKey, when using callback type 'CallbackOnEndEventReached'!`);
    }

    const executionContext: ExecutionContext = await this._createExecutionContextFromConsumerContext(context);
    const correlationId: string = payload.correlationId || uuid.v4();
    const processModel: Model.Types.Process = await this.processModelPersistance.getProcessModelById(processModelId);

    if (startCallbackType === StartCallbackType.CallbackOnProcessInstanceCreated) {
      this.executeProcessService.start(executionContext, processModel, correlationId, payload.inputValues);
    } else if (startCallbackType === StartCallbackType.CallbackOnEndEventReached && endEventKey) {
      this.executeProcessService.startAndAwaitSpecificEndEvent(executionContext, processModel, correlationId, endEventKey, payload.inputValues);
    } else {
      this.executeProcessService.startAndAwaitEndEvent(executionContext, processModel, correlationId, payload.inputValues);
    }

    const response: ProcessStartResponsePayload = {
      correlationId: correlationId,
    };

    return response;
  }

  public async getProcessResultForCorrelation(context: ConsumerContext,
                                              correlationId: string,
                                              processModelId: string): Promise<ICorrelationResult> {

    const processModel: Model.Types.Process =
      await this.processModelPersistance.getProcessModelById(processModelId);

    const processModelFacade: IProcessModelFacade = this.processModelFacadeFactory.create(processModel);
    const endEvents: Array<Model.Events.EndEvent> = processModelFacade.getEndEvents();

    const flowNodeInstances: Array<Runtime.Types.FlowNodeInstance> =
      await this.flowNodeInstancePersistance.queryByCorrelation(correlationId);

    const endEventInstances: Array<Runtime.Types.FlowNodeInstance>
      = flowNodeInstances.filter((flowNodeInstance: Runtime.Types.FlowNodeInstance) => {

        const isEndEvent: boolean = endEvents.some((endEvent: Model.Events.EndEvent) => {
          return endEvent.id === flowNodeInstance.flowNodeId;
        });

        return isEndEvent
          && flowNodeInstance.token.caller === undefined // only from the process who started the correlation
          && flowNodeInstance.token.processModelId === processModelId;
    });

    const correlationResult: ICorrelationResult = {};

    // merge results
    for (const endEventInstance of endEventInstances) {
      Object.assign(correlationResult, endEventInstance.token.payload);
    }

    return correlationResult;
  }

  // Events
  public async getEventsForProcessModel(context: ConsumerContext, processModelKey: string): Promise<EventList> {
    return this.processEngineAdapter.getEventsForProcessModel(context, processModelKey);
  }

  public async getEventsForCorrelation(context: ConsumerContext, correlationId: string): Promise<EventList> {
    return this.processEngineAdapter.getEventsForCorrelation(context, correlationId);
  }

  public async getEventsForProcessModelInCorrelation(context: ConsumerContext, processModelKey: string, correlationId: string): Promise<EventList> {
    return this.processEngineAdapter.getEventsForProcessModelInCorrelation(context, processModelKey, correlationId);
  }

  public async triggerEvent(context: ConsumerContext,
                            processModelKey: string,
                            correlationId: string,
                            eventId: string,
                            eventTriggerPayload?: EventTriggerPayload): Promise<void> {

    return this.processEngineAdapter.triggerEvent(context, processModelKey, correlationId, eventId, eventTriggerPayload);
  }

  // UserTasks
  public async getUserTasksForProcessModel(context: ConsumerContext, processModelId: string): Promise<UserTaskList> {

    const suspendedFlowNodes: Array<Runtime.Types.FlowNodeInstance>
      = await this.flowNodeInstancePersistance.querySuspendedByProcessModel(processModelId);

    const userTaskList: UserTaskList = await this._convertSuspendedFlowNodesToUserTaskList(suspendedFlowNodes);

    return userTaskList;
  }

  private _convertToConsumerApiUserTask(userTask: Model.Activities.UserTask, flowNodeInstance: Runtime.Types.FlowNodeInstance): UserTask {

    const consumerApiFormFields: Array<UserTaskFormField> = userTask.formFields.map((formField: Model.Types.FormField) => {
      return this._convertToConsumerApiFormField(formField);
    });

    const userTaskConfig: UserTaskConfig = {
      formFields: consumerApiFormFields,
    };

    const consumerApiUserTask: UserTask = {
      key: flowNodeInstance.flowNodeId,
      id: flowNodeInstance.flowNodeId,
      processInstanceId: flowNodeInstance.token.processInstanceId,
      data: userTaskConfig,
      payload: flowNodeInstance.token.payload,
    };

    return consumerApiUserTask;
  }

  private _convertToConsumerApiFormFieldType(type: string): UserTaskFormFieldType {
    return UserTaskFormFieldType[type];
  }

  private _convertToConsumerApiFormField(formField: Model.Types.FormField): UserTaskFormField {

    const userTaskFormField: UserTaskFormField = new UserTaskFormField();
    userTaskFormField.id = formField.id;
    userTaskFormField.label = formField.label;
    userTaskFormField.type = this._convertToConsumerApiFormFieldType(formField.type);
    userTaskFormField.defaultValue = formField.defaultValue;
    userTaskFormField.preferredControl = formField.preferredControl;

    return userTaskFormField;
  }

  private async _convertSuspendedFlowNodesToUserTaskList(suspendedFlowNodes: Array<Runtime.Types.FlowNodeInstance>): Promise<UserTaskList> {

    const suspendedUserTasks: Array<UserTask> = [];

    for (const suspendedFlowNode of suspendedFlowNodes) {

      const userTask: UserTask = await this._convertSuspendedFlowNodeToUserTask(suspendedFlowNode);

      if (userTask === undefined) {
        continue;
      }

      suspendedUserTasks.push(userTask);
    }

    const userTaskList: UserTaskList = {
      userTasks: suspendedUserTasks,
    };

    return userTaskList;
  }

  private async _convertSuspendedFlowNodeToUserTask(flowNodeInstance: Runtime.Types.FlowNodeInstance): Promise<UserTask> {

    const processModel: Model.Types.Process =
    await this.processModelPersistance.getProcessModelById(flowNodeInstance.token.processModelId);

    const processModelFacade: IProcessModelFacade = this.processModelFacadeFactory.create(processModel);
    const userTask: Model.Activities.UserTask = processModelFacade.getFlowNodeById(flowNodeInstance.flowNodeId) as Model.Activities.UserTask;

    if (!(userTask instanceof Model.Activities.UserTask)) {
      return undefined;
    }

    const consumerApiFormFields: Array<UserTaskFormField> = userTask.formFields.map((formField: Model.Types.FormField) => {
      return this._convertToConsumerApiFormField(formField);
    });

    const userTaskConfig: UserTaskConfig = {
      formFields: consumerApiFormFields,
    };

    return this._convertToConsumerApiUserTask(userTask, flowNodeInstance);
  }

  public async getUserTasksForCorrelation(context: ConsumerContext, correlationId: string): Promise<UserTaskList> {

    const suspendedFlowNodes: Array<Runtime.Types.FlowNodeInstance> =
      await this.flowNodeInstancePersistance.querySuspendedByCorrelation(correlationId);

    const userTaskList: UserTaskList = await this._convertSuspendedFlowNodesToUserTaskList(suspendedFlowNodes);

    return userTaskList;
  }

  public async getUserTasksForProcessModelInCorrelation(context: ConsumerContext,
                                                        processModelId: string,
                                                        correlationId: string): Promise<UserTaskList> {

    const suspendedFlowNodes: Array<Runtime.Types.FlowNodeInstance> =
      await this.flowNodeInstancePersistance.querySuspendedByCorrelation(correlationId);

    const suspendedUserTasks: Array<UserTask> = [];

    for (const suspendedFlowNode of suspendedFlowNodes) {

      // this duplicates _convertSuspendedFlowNodesToUserTaskList because it
      // needs to perform an additional check for the process model
      if (suspendedFlowNode.token.processModelId !== processModelId) {
        continue;
      }

      const userTask: UserTask = await this._convertSuspendedFlowNodeToUserTask(suspendedFlowNode);

      if (userTask === undefined) {
        continue;
      }

      suspendedUserTasks.push(userTask);
    }

    const userTaskList: UserTaskList = {
      userTasks: suspendedUserTasks,
    };

    return userTaskList;
  }

  private _createExecutionContextFromConsumerContext(consumerContext: ConsumerContext): Promise<ExecutionContext> {
    return this.processEngineIamService.resolveExecutionContext(consumerContext.identity, TokenType.jwt);
  }

  public async finishUserTask(context: ConsumerContext,
                              processModelId: string,
                              correlationId: string,
                              userTaskId: string,
                              userTaskResult: UserTaskResult): Promise<void> {

    const executionContext: ExecutionContext = await this._createExecutionContextFromConsumerContext(context);

    const userTasks: UserTaskList = await this.getUserTasksForProcessModelInCorrelation(context, processModelId, correlationId);

    const userTask: UserTask = userTasks.userTasks.find((task: UserTask) => {
      return task.key === userTaskId;
    });

    if (userTask === undefined) {
      const errorMessage: string = `Process model '${processModelId}' in correlation '${correlationId}' does not have a user task '${userTaskId}'`;
      throw new EssentialProjectErrors.NotFoundError(errorMessage);
    }

    const resultForProcessEngine: any = this._getUserTaskResultFromUserTaskConfig(userTaskResult);

    return new Promise<void>((resolve: Function, reject: Function): void => {
      this.eventAggregator.subscribeOnce(`/processengine/node/${userTask.id}/finished`, (event: any) => {
        resolve();
      });

      this.eventAggregator.publish(`/processengine/node/${userTask.id}/finish`, {
        data: {
          token: resultForProcessEngine,
        },
      });
    });

  }

  private _getUserTaskResultFromUserTaskConfig(finishedTask: UserTaskResult): any {
    const userTaskIsNotAnObject: boolean = finishedTask === undefined
                                        || finishedTask.formFields === undefined
                                        || typeof finishedTask.formFields !== 'object'
                                        || Array.isArray(finishedTask.formFields);

    if (userTaskIsNotAnObject) {
      throw new EssentialProjectErrors.BadRequestError('The UserTasks formFields is not an object.');
    }

    const noFormfieldsSubmitted: boolean = Object.keys(finishedTask.formFields).length === 0;
    if (noFormfieldsSubmitted) {
      throw new EssentialProjectErrors.BadRequestError('The UserTasks formFields are empty.');
    }

    return finishedTask.formFields;
  }
}
