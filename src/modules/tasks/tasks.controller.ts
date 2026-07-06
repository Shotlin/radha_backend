import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  Version,
} from '@nestjs/common';

import { ParseUuidPipe } from '@/common/pipes/parse-uuid.pipe';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
  RequireTenant,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '@/modules/auth/guards/permissions.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';

import {
  AddEvidenceDto,
  AddEvidenceSchema,
  AutoTaskFromAlertDto,
  AutoTaskFromAlertSchema,
  CancelTaskDto,
  CancelTaskSchema,
  CompleteTaskDto,
  CompleteTaskSchema,
  CreateTaskDto,
  CreateTaskSchema,
  CreateTemplateDto,
  CreateTemplateSchema,
  InstantiateTemplateDto,
  InstantiateTemplateSchema,
  ListTasksQueryDto,
  ListTasksQuerySchema,
  ListTemplatesQueryDto,
  ListTemplatesQuerySchema,
  MyTasksQueryDto,
  MyTasksQuerySchema,
  ReassignTaskDto,
  ReassignTaskSchema,
  RejectTaskDto,
  RejectTaskSchema,
  StatsQueryDto,
  StatsQuerySchema,
  UpdateTaskDto,
  UpdateTaskSchema,
  UpdateTemplateDto,
  UpdateTemplateSchema,
} from './dto/tasks.dto';
import { AutoTaskGeneratorService } from './services/auto-task-generator.service';
import { TaskTemplatesService } from './services/task-templates.service';
import { TasksService } from './tasks.service';

/**
 * BE-19 — Task management REST surface.
 *
 *   /api/v1/tasks/...
 *   /api/v1/task-templates/...
 *
 * Static segments precede `:id` routes so `/tasks/my`, `/tasks/stats`,
 * `/tasks/auto-from-alert` resolve correctly.
 *
 * Permissions:
 *   - reads        : `tasks:read`
 *   - writes       : `tasks:write`
 *   - reassign     : `tasks:assign`
 *   - delete/cancel: `tasks:delete`
 *
 * Tenant scoping is mandatory via `@RequireTenant()`.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly templates: TaskTemplatesService,
    private readonly autoGen: AutoTaskGeneratorService,
  ) {}

  /* ─────────────────── Templates (static segments first) ─────────────────── */

  @Post('task-templates')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('tasks:write')
  @RequireTenant()
  createTemplate(
    @Body(new ZodValidationPipe(CreateTemplateSchema)) dto: CreateTemplateDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.templates.create(tenantId, userId, dto);
  }

  @Get('task-templates')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('tasks:read')
  @RequireTenant()
  listTemplates(
    @Query(new ZodValidationPipe(ListTemplatesQuerySchema)) query: ListTemplatesQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.templates.list(tenantId, query);
  }

  @Get('task-templates/:id')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('tasks:read')
  @RequireTenant()
  getTemplate(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.templates.findById(tenantId, id);
  }

  @Patch('task-templates/:id')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('tasks:write')
  @RequireTenant()
  updateTemplate(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateTemplateSchema)) dto: UpdateTemplateDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.templates.update(tenantId, userId, id, dto);
  }

  @Delete('task-templates/:id')
  @Version('1')
  @HttpCode(204)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('tasks:delete')
  @RequireTenant()
  async deleteTemplate(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.templates.delete(tenantId, userId, id);
  }

  @Post('task-templates/:id/instantiate')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('tasks:write')
  @RequireTenant()
  instantiateTemplate(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(InstantiateTemplateSchema)) dto: InstantiateTemplateDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.templates.instantiate(tenantId, userId, id, dto);
  }

  /* ─────────────────── Tasks: static segments first ─────────────────── */

  @Get('tasks/my')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('tasks:read')
  @RequireTenant()
  myTasks(
    @Query(new ZodValidationPipe(MyTasksQuerySchema)) query: MyTasksQueryDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.tasks.listForUser(tenantId, userId, query);
  }

  @Get('tasks/stats')
  @Version('1')
  @Roles('owner', 'manager', 'auditor', 'admin')
  @RequirePermissions('tasks:read')
  @RequireTenant()
  stats(
    @Query(new ZodValidationPipe(StatsQuerySchema)) query: StatsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.tasks.getStats(tenantId, query);
  }

  @Post('tasks/auto-from-alert')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('tasks:write', 'tasks:assign')
  @RequireTenant()
  autoFromAlert(
    @Body(new ZodValidationPipe(AutoTaskFromAlertSchema)) dto: AutoTaskFromAlertDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.autoGen.generateForAlert(tenantId, userId, dto);
  }

  /* ─────────────────── Tasks CRUD ─────────────────── */

  @Post('tasks')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('tasks:write', 'tasks:assign')
  @RequireTenant()
  create(
    @Body(new ZodValidationPipe(CreateTaskSchema)) dto: CreateTaskDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.tasks.create(tenantId, userId, dto);
  }

  @Get('tasks')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('tasks:read')
  @RequireTenant()
  list(
    @Query(new ZodValidationPipe(ListTasksQuerySchema)) query: ListTasksQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.tasks.list(tenantId, query);
  }

  @Get('tasks/:id')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('tasks:read')
  @RequireTenant()
  get(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.tasks.findById(tenantId, id);
  }

  @Patch('tasks/:id')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('tasks:write')
  @RequireTenant()
  update(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateTaskSchema)) dto: UpdateTaskDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.tasks.update(tenantId, userId, id, dto);
  }

  @Delete('tasks/:id')
  @Version('1')
  @HttpCode(204)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('tasks:delete')
  @RequireTenant()
  async remove(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.tasks.delete(tenantId, userId, id);
  }

  /* ─────────────────── Workflow ─────────────────── */

  @Post('tasks/:id/start')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('tasks:write')
  @RequireTenant()
  start(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.tasks.start(tenantId, userId, id);
  }

  @Post('tasks/:id/complete')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('tasks:write')
  @RequireTenant()
  complete(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(CompleteTaskSchema)) dto: CompleteTaskDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.tasks.complete(tenantId, userId, id, dto);
  }

  @Post('tasks/:id/reject')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('tasks:write')
  @RequireTenant()
  reject(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(RejectTaskSchema)) dto: RejectTaskDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.tasks.reject(tenantId, userId, id, dto.reason);
  }

  @Post('tasks/:id/cancel')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('tasks:delete')
  @RequireTenant()
  cancel(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(CancelTaskSchema)) dto: CancelTaskDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.tasks.cancel(tenantId, userId, id, dto.reason);
  }

  @Post('tasks/:id/reassign')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('tasks:assign')
  @RequireTenant()
  reassign(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(ReassignTaskSchema)) dto: ReassignTaskDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.tasks.reassign(tenantId, userId, id, dto);
  }

  /* ─────────────────── Evidence ─────────────────── */

  @Post('tasks/:id/evidence')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('tasks:write')
  @RequireTenant()
  addEvidence(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(AddEvidenceSchema)) dto: AddEvidenceDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.tasks.addEvidence(tenantId, userId, id, dto);
  }

  @Delete('tasks/evidence/:evidenceId')
  @Version('1')
  @HttpCode(204)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('tasks:write')
  @RequireTenant()
  async removeEvidence(
    @Param('evidenceId', new ParseUuidPipe()) evidenceId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.tasks.removeEvidence(tenantId, userId, evidenceId);
  }
}
