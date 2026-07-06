import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { ExpiryModule } from '@/modules/expiry/expiry.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { TaskAssignmentsRepository } from './repositories/task-assignments.repository';
import { TaskEventsRepository } from './repositories/task-events.repository';
import { TaskEvidenceRepository } from './repositories/task-evidence.repository';
import { TaskTemplatesRepository } from './repositories/task-templates.repository';
import { TasksRepository } from './repositories/tasks.repository';
import { AutoTaskGeneratorService } from './services/auto-task-generator.service';
import { RecurringTasksService } from './services/recurring-tasks.service';
import { TaskAssignmentService } from './services/task-assignment.service';
import { TaskEvidenceService } from './services/task-evidence.service';
import { TaskTemplatesService } from './services/task-templates.service';
import { TaskWorkflowService } from './services/task-workflow.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * BE-19 — Task management module.
 *
 * Imports:
 *   - AuthModule          → BE-08 guard stack + decorators.
 *   - ExpiryModule        → BE-18 alerts repository (auto-task generator).
 *   - ObservabilityModule → AuditLogService.
 *
 * Exported symbols:
 *   - TasksService                — used by BE-20 reports / BE-24 cron.
 *   - AutoTaskGeneratorService    — used by BE-18 alert hooks once
 *                                   the wiring lands in BE-24.
 *   - TaskTemplatesService        — used by App Owner Dashboard (BE-31).
 *   - TasksRepository / events    — used by BE-25 reports for raw queries.
 */
@Module({
  imports: [AuthModule, ExpiryModule, ObservabilityModule],
  controllers: [TasksController],
  providers: [
    TasksRepository,
    TaskAssignmentsRepository,
    TaskEventsRepository,
    TaskEvidenceRepository,
    TaskTemplatesRepository,

    TaskWorkflowService,
    TaskAssignmentService,
    TaskEvidenceService,
    RecurringTasksService,
    AutoTaskGeneratorService,
    TaskTemplatesService,
    TasksService,
  ],
  exports: [
    TasksService,
    TaskTemplatesService,
    AutoTaskGeneratorService,
    TaskWorkflowService,
    TasksRepository,
    TaskAssignmentsRepository,
    TaskEventsRepository,
    TaskEvidenceRepository,
    TaskTemplatesRepository,
  ],
})
export class TasksModule {}
