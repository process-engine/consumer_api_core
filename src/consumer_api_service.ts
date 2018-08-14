import * as EssentialProjectErrors from '@essential-projects/errors_ts';
import {IEventAggregator} from '@essential-projects/event_aggregator_contracts';
import {IIdentity} from '@essential-projects/iam_contracts';
import {
  ConsumerContext,
  CorrelationResult,
  EventList,
  EventTriggerPayload,
  IConsumerApiService,
  ProcessModel,
  ProcessModelList,
  ProcessStartRequestPayload,
  ProcessStartResponsePayload,
  StartCallbackType,
  UserTask,
  UserTaskList,
  UserTaskResult,
} from '@process-engine/consumer_api_contracts';
import {
  ExecutionContext,
  IExecutionContextFacade,
  IExecutionContextFacadeFactory,
  IFlowNodeInstanceService,
  IProcessModelFacade,
  IProcessModelFacadeFactory,
  IProcessModelService,
  Model,
  Runtime,
} from '@process-engine/process_engine_contracts';

import {IProcessModelExecutionAdapter} from './adapters/index';
import * as Converters from './converters/index';

const mockEventList: EventList = {
  events: [{
    id: 'startEvent_1',
    processInstanceId: '',
    data: {},
  }],
};

export class ConsumerApiService implements IConsumerApiService {
  public config: any = undefined;

  private _eventAggregator: IEventAggregator;
  private _executionContextFacadeFactory: IExecutionContextFacadeFactory;
  private _processModelExecutionAdapter: IProcessModelExecutionAdapter;
  private _processModelFacadeFactory: IProcessModelFacadeFactory;
  private _processModelService: IProcessModelService;
  private _flowNodeInstanceService: IFlowNodeInstanceService;

  private convertProcessModel: Function;
  private convertUserTasks: Function;

  constructor(eventAggregator: IEventAggregator,
              executionContextFacadeFactory: IExecutionContextFacadeFactory,
              flowNodeInstanceService: IFlowNodeInstanceService,
              processModelExecutionAdapter: IProcessModelExecutionAdapter,
              processModelFacadeFactory: IProcessModelFacadeFactory,
              processModelService: IProcessModelService) {

    this._eventAggregator = eventAggregator;
    this._executionContextFacadeFactory = executionContextFacadeFactory;
    this._flowNodeInstanceService = flowNodeInstanceService;
    this._processModelExecutionAdapter = processModelExecutionAdapter;
    this._processModelFacadeFactory = processModelFacadeFactory;
    this._processModelService = processModelService;
  }

  private get eventAggregator(): IEventAggregator {
    return this._eventAggregator;
  }

  private get executionContextFacadeFactory(): IExecutionContextFacadeFactory {
    return this._executionContextFacadeFactory;
  }

  private get flowNodeInstanceService(): IFlowNodeInstanceService {
    return this._flowNodeInstanceService;
  }

  private get processModelExecutionAdapter(): IProcessModelExecutionAdapter {
    return this._processModelExecutionAdapter;
  }

  private get processModelFacadeFactory(): IProcessModelFacadeFactory {
    return this._processModelFacadeFactory;
  }

  private get processModelService(): IProcessModelService {
    return this._processModelService;
  }

  public async initialize(): Promise<void> {

    this.convertProcessModel = Converters.createProcessModelConverter(this.processModelFacadeFactory);
    this.convertUserTasks = Converters.createUserTaskConverter(this.processModelFacadeFactory, this.processModelService);

    return Promise.resolve();
  }

  // Process models
  public async getProcessModels(context: ConsumerContext): Promise<ProcessModelList> {

    const executionContextFacade: IExecutionContextFacade = await this._createExecutionContextFacadeFromConsumerContext(context);
    const processModels: Array<Model.Types.Process> = await this.processModelService.getProcessModels(executionContextFacade);
    const consumerApiProcessModels: Array<ProcessModel> = processModels.map((processModel: Model.Types.Process) => {
      return this.convertProcessModel(processModel);
    });

    return <ProcessModelList> {
      processModels: consumerApiProcessModels,
    };
  }

  public async getProcessModelById(context: ConsumerContext, processModelKey: string): Promise<ProcessModel> {

    const executionContextFacade: IExecutionContextFacade = await this._createExecutionContextFacadeFromConsumerContext(context);
    const processModel: Model.Types.Process = await this.processModelService.getProcessModelById(executionContextFacade, processModelKey);
    const consumerApiProcessModel: ProcessModel = this.convertProcessModel(processModel);

    return consumerApiProcessModel;
  }

  public async startProcessInstance(context: ConsumerContext,
                                    processModelId: string,
                                    startEventId: string,
                                    payload: ProcessStartRequestPayload,
                                    startCallbackType: StartCallbackType = StartCallbackType.CallbackOnProcessInstanceCreated,
                                    endEventId?: string,
                                  ): Promise<ProcessStartResponsePayload> {

    const executionContextFacade: IExecutionContextFacade = await this._createExecutionContextFacadeFromConsumerContext(context);

    // Uses the standard IAM facade with the processModelService => The process model gets filtered.
    const processModel: Model.Types.Process = await this.processModelService.getProcessModelById(executionContextFacade, processModelId);

    this._validateStartRequest(processModel, startEventId, endEventId, startCallbackType);

    return this.processModelExecutionAdapter
      .startProcessInstance(executionContextFacade, processModelId, startEventId, payload, startCallbackType, endEventId);
  }

  public async getProcessResultForCorrelation(context: ConsumerContext,
                                              correlationId: string,
                                              processModelId: string): Promise<Array<CorrelationResult>> {

    const executionContextFacade: IExecutionContextFacade = await this._createExecutionContextFacadeFromConsumerContext(context);

    const processModel: Model.Types.Process =
      await this.processModelService.getProcessModelById(executionContextFacade, processModelId);

    const processModelFacade: IProcessModelFacade = this.processModelFacadeFactory.create(processModel);
    const endEvents: Array<Model.Events.EndEvent> = processModelFacade.getEndEvents();

    const flowNodeInstances: Array<Runtime.Types.FlowNodeInstance> =
      await this.flowNodeInstanceService.queryByCorrelation(executionContextFacade, correlationId);

    if (!flowNodeInstances || flowNodeInstances.length === 0) {
      throw new EssentialProjectErrors.NotFoundError(`No process results for correlation with id '${correlationId}' found.`);
    }

    const endEventInstances: Array<Runtime.Types.FlowNodeInstance>
      = flowNodeInstances.filter((flowNodeInstance: Runtime.Types.FlowNodeInstance) => {

        const isEndEvent: boolean = endEvents.some((endEvent: Model.Events.EndEvent) => {
          return endEvent.id === flowNodeInstance.flowNodeId;
        });

        return isEndEvent
          && !flowNodeInstance.token.caller // only from the process who started the correlation
          && flowNodeInstance.token.processModelId === processModelId;
    });

    const results: Array<CorrelationResult> = [];

    // merge results
    for (const endEventInstance of endEventInstances) {
      const correlationResult: CorrelationResult = {
        correlationId: endEventInstance.token.correlationId,
        endEventId: endEventInstance.flowNodeId,
        tokenPayload: endEventInstance.token.payload,
      };

      results.push(correlationResult);
    }

    return results;
  }

  // Events
  public async getEventsForProcessModel(context: ConsumerContext, processModelKey: string): Promise<EventList> {
    return Promise.resolve(mockEventList);
  }

  public async getEventsForCorrelation(context: ConsumerContext, correlationId: string): Promise<EventList> {
    return Promise.resolve(mockEventList);
  }

  public async getEventsForProcessModelInCorrelation(context: ConsumerContext, processModelKey: string, correlationId: string): Promise<EventList> {
    return Promise.resolve(mockEventList);
  }

  public async triggerEvent(context: ConsumerContext,
                            processModelKey: string,
                            correlationId: string,
                            eventId: string,
                            eventTriggerPayload?: EventTriggerPayload): Promise<void> {
    return Promise.resolve();
  }

  // UserTasks
  public async getUserTasksForProcessModel(context: ConsumerContext, processModelId: string): Promise<UserTaskList> {

    const executionContextFacade: IExecutionContextFacade = await this._createExecutionContextFacadeFromConsumerContext(context);

    await this._checkIfProcessModelInstanceExists(executionContextFacade, processModelId);

    const suspendedFlowNodes: Array<Runtime.Types.FlowNodeInstance> =
      await this.flowNodeInstanceService.querySuspendedByProcessModel(executionContextFacade, processModelId);

    const userTaskList: UserTaskList = await this.convertUserTasks(executionContextFacade, suspendedFlowNodes);

    return userTaskList;
  }

  public async getUserTasksForCorrelation(context: ConsumerContext, correlationId: string): Promise<UserTaskList> {

    const executionContextFacade: IExecutionContextFacade = await this._createExecutionContextFacadeFromConsumerContext(context);

    await this._checkIfCorrelationExists(executionContextFacade, correlationId);

    const suspendedFlowNodes: Array<Runtime.Types.FlowNodeInstance> =
      await this.flowNodeInstanceService.querySuspendedByCorrelation(executionContextFacade, correlationId);

    const userTaskList: UserTaskList = await this.convertUserTasks(executionContextFacade, suspendedFlowNodes);

    return userTaskList;
  }

  public async getUserTasksForProcessModelInCorrelation(context: ConsumerContext,
                                                        processModelId: string,
                                                        correlationId: string): Promise<UserTaskList> {

    const executionContextFacade: IExecutionContextFacade = await this._createExecutionContextFacadeFromConsumerContext(context);

    await this._checkIfCorrelationExists(executionContextFacade, correlationId);
    await this._checkIfProcessModelInstanceExists(executionContextFacade, processModelId);

    const suspendedFlowNodes: Array<Runtime.Types.FlowNodeInstance> =
      await this.flowNodeInstanceService.querySuspendedByCorrelation(executionContextFacade, correlationId);

    const userTaskList: UserTaskList =
      await this.convertUserTasks(executionContextFacade, suspendedFlowNodes, processModelId);

    return userTaskList;
  }

  public async finishUserTask(context: ConsumerContext,
                              processModelId: string,
                              correlationId: string,
                              userTaskId: string,
                              userTaskResult: UserTaskResult): Promise<void> {

    const userTasks: UserTaskList = await this.getUserTasksForProcessModelInCorrelation(context, processModelId, correlationId);

    const userTask: UserTask = userTasks.userTasks.find((task: UserTask) => {
      return task.id === userTaskId;
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

  private async _createExecutionContextFacadeFromConsumerContext(consumerContext: ConsumerContext): Promise<IExecutionContextFacade> {
    const identity: IIdentity = {
      token: consumerContext.identity,
    };
    const executionContext: ExecutionContext = new ExecutionContext(identity);

    return this.executionContextFacadeFactory.create(executionContext);
  }

  private _validateStartRequest(processModel: Model.Types.Process,
                                startEventId: string,
                                endEventId: string,
                                startCallbackType: StartCallbackType,
                               ): void {

    if (!Object.values(StartCallbackType).includes(startCallbackType)) {
      throw new EssentialProjectErrors.BadRequestError(`${startCallbackType} is not a valid return option!`);
    }

    if (!processModel.isExecutable) {
      throw new EssentialProjectErrors.BadRequestError('The process model is not executable!');
    }

    const hasMatchingStartEvent: boolean = processModel.flowNodes.some((flowNode: Model.Base.FlowNode): boolean => {
      return flowNode.id === startEventId;
    });

    if (!hasMatchingStartEvent) {
      throw new EssentialProjectErrors.NotFoundError(`StartEvent with ID '${startEventId}' not found!`);
    }

    if (startCallbackType === StartCallbackType.CallbackOnEndEventReached) {

      if (!endEventId) {
        throw new EssentialProjectErrors.BadRequestError(`Must provide an EndEventId, when using callback type 'CallbackOnEndEventReached'!`);
      }

      const hasMatchingEndEvent: boolean = processModel.flowNodes.some((flowNode: Model.Base.FlowNode): boolean => {
        return flowNode.id === endEventId;
      });

      if (!hasMatchingEndEvent) {
        throw new EssentialProjectErrors.NotFoundError(`EndEvent with ID '${startEventId}' not found!`);
      }
    }
  }

  private async _checkIfCorrelationExists(executionContextFacade: IExecutionContextFacade, correlationId: string): Promise<void> {
    const flowNodeInstances: Array<Runtime.Types.FlowNodeInstance> =
      await this.flowNodeInstanceService.queryByCorrelation(executionContextFacade, correlationId);

    if (!flowNodeInstances || flowNodeInstances.length === 0) {
      throw new EssentialProjectErrors.NotFoundError(`No Correlation with id '${correlationId}' found.`);
    }
  }

  private async _checkIfProcessModelInstanceExists(executionContextFacade: IExecutionContextFacade, processInstanceId: string): Promise<void> {
    const flowNodeInstances: Array<Runtime.Types.FlowNodeInstance> =
      await this.flowNodeInstanceService.queryByProcessModel(executionContextFacade, processInstanceId);

    if (!flowNodeInstances || flowNodeInstances.length === 0) {
      throw new EssentialProjectErrors.NotFoundError(`No process instance with id '${processInstanceId}' found.`);
    }
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