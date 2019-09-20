import {APIs, DataModels} from '@process-engine/consumer_api_contracts';
import {
  FlowNodeInstance,
  FlowNodeInstanceState,
  IFlowNodeInstanceService,
} from '@process-engine/flow_node_instance.contracts';
import {IIdentity} from '@essential-projects/iam_contracts';

import {EmptyActivityConverter, ManualTaskConverter, UserTaskConverter} from './converters/index';
import {applyPagination} from './paginator';

export class FlowNodeInstanceService implements APIs.IFlowNodeInstanceConsumerApi {

  private readonly flowNodeInstanceService: IFlowNodeInstanceService;

  private readonly userTaskConverter: UserTaskConverter;
  private readonly manualTaskConverter: ManualTaskConverter;
  private readonly emptyActivityConverter: EmptyActivityConverter;

  constructor(
    flowNodeInstanceService: IFlowNodeInstanceService,
    emptyActivityConverter: EmptyActivityConverter,
    manualTaskConverter: ManualTaskConverter,
    userTaskConverter: UserTaskConverter,
  ) {
    this.flowNodeInstanceService = flowNodeInstanceService;

    this.emptyActivityConverter = emptyActivityConverter;
    this.manualTaskConverter = manualTaskConverter;
    this.userTaskConverter = userTaskConverter;
  }

  public async getAllSuspendedTasks(
    identity: IIdentity,
    offset: number = 0,
    limit: number = 0,
  ): Promise<DataModels.FlowNodeInstances.TaskList> {

    const suspendedFlowNodes = await this.flowNodeInstanceService.queryByState(FlowNodeInstanceState.suspended);

    const userTaskList = await this.userTaskConverter.convertUserTasks(identity, suspendedFlowNodes);
    const manualTaskList = await this.manualTaskConverter.convert(identity, suspendedFlowNodes);
    const emptyActivityList = await this.emptyActivityConverter.convert(identity, suspendedFlowNodes);

    const tasks = emptyActivityList.emptyActivities.concat(manualTaskList.manualTasks, userTaskList.userTasks);

    const taskList: DataModels.FlowNodeInstances.TaskList = {
      tasks: applyPagination(tasks, offset, limit),
      totalCount: tasks.length,
    };

    return taskList;
  }

  public async getSuspendedTasksForProcessModel(
    identity: IIdentity,
    processModelId: string,
    offset: number = 0,
    limit: number = 0,
  ): Promise<DataModels.FlowNodeInstances.TaskList> {

    const suspendedFlowNodes = await this.flowNodeInstanceService.querySuspendedByProcessModel(processModelId);

    const userTaskList = await this.userTaskConverter.convertUserTasks(identity, suspendedFlowNodes);
    const manualTaskList = await this.manualTaskConverter.convert(identity, suspendedFlowNodes);
    const emptyActivityList = await this.emptyActivityConverter.convert(identity, suspendedFlowNodes);

    const tasks = emptyActivityList.emptyActivities.concat(manualTaskList.manualTasks, userTaskList.userTasks);

    const taskList: DataModels.FlowNodeInstances.TaskList = {
      tasks: applyPagination(tasks, offset, limit),
      totalCount: tasks.length,
    };

    return taskList;
  }

  public async getSuspendedTasksForProcessInstance(
    identity: IIdentity,
    processInstanceId: string,
    offset: number = 0,
    limit: number = 0,
  ): Promise<DataModels.FlowNodeInstances.TaskList> {

    const suspendedFlowNodes = await this.flowNodeInstanceService.querySuspendedByProcessInstance(processInstanceId);

    const userTaskList = await this.userTaskConverter.convertUserTasks(identity, suspendedFlowNodes);
    const manualTaskList = await this.manualTaskConverter.convert(identity, suspendedFlowNodes);
    const emptyActivityList = await this.emptyActivityConverter.convert(identity, suspendedFlowNodes);

    const tasks = emptyActivityList.emptyActivities.concat(manualTaskList.manualTasks, userTaskList.userTasks);

    const taskList: DataModels.FlowNodeInstances.TaskList = {
      tasks: applyPagination(tasks, offset, limit),
      totalCount: tasks.length,
    };

    return taskList;
  }

  public async getSuspendedTasksForCorrelation(
    identity: IIdentity,
    correlationId: string,
    offset: number = 0,
    limit: number = 0,
  ): Promise<DataModels.FlowNodeInstances.TaskList> {

    const suspendedFlowNodes = await this.flowNodeInstanceService.querySuspendedByCorrelation(correlationId);

    const userTaskList = await this.userTaskConverter.convertUserTasks(identity, suspendedFlowNodes);
    const manualTaskList = await this.manualTaskConverter.convert(identity, suspendedFlowNodes);
    const emptyActivityList = await this.emptyActivityConverter.convert(identity, suspendedFlowNodes);

    const tasks = emptyActivityList.emptyActivities.concat(manualTaskList.manualTasks, userTaskList.userTasks);

    const taskList: DataModels.FlowNodeInstances.TaskList = {
      tasks: applyPagination(tasks, offset, limit),
      totalCount: tasks.length,
    };

    return taskList;
  }

  public async getSuspendedTasksForProcessModelInCorrelation(
    identity: IIdentity,
    processModelId: string,
    correlationId: string,
    offset: number = 0,
    limit: number = 0,
  ): Promise<DataModels.FlowNodeInstances.TaskList> {

    const flowNodeInstances = await this.flowNodeInstanceService.queryActiveByCorrelationAndProcessModel(correlationId, processModelId);

    const suspendedFlowNodeInstances = flowNodeInstances.filter((flowNodeInstance: FlowNodeInstance): boolean => {
      return flowNodeInstance.state === FlowNodeInstanceState.suspended;
    });

    const noSuspendedFlowNodesFound = !suspendedFlowNodeInstances || suspendedFlowNodeInstances.length === 0;
    if (noSuspendedFlowNodesFound) {
      return <DataModels.FlowNodeInstances.TaskList> {
        tasks: [],
        totalCount: 0,
      };
    }

    const userTaskList = await this.userTaskConverter.convertUserTasks(identity, suspendedFlowNodeInstances);
    const manualTaskList = await this.manualTaskConverter.convert(identity, suspendedFlowNodeInstances);
    const emptyActivityList = await this.emptyActivityConverter.convert(identity, suspendedFlowNodeInstances);

    const tasks = emptyActivityList.emptyActivities.concat(manualTaskList.manualTasks, userTaskList.userTasks);

    const taskList: DataModels.FlowNodeInstances.TaskList = {
      tasks: applyPagination(tasks, offset, limit),
      totalCount: tasks.length,
    };

    return taskList;
  }

}