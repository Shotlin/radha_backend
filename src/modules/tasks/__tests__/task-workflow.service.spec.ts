import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

import { TaskWorkflowService } from '../services/task-workflow.service';

describe('TaskWorkflowService.validateTransition', () => {
  const svc = new TaskWorkflowService();

  it('allows pending → in_progress', () => {
    expect(() => svc.validateTransition('pending', 'in_progress')).not.toThrow();
  });

  it('allows pending → cancelled', () => {
    expect(() => svc.validateTransition('pending', 'cancelled')).not.toThrow();
  });

  it('allows in_progress → completed', () => {
    expect(() => svc.validateTransition('in_progress', 'completed')).not.toThrow();
  });

  it('allows in_progress → rejected', () => {
    expect(() => svc.validateTransition('in_progress', 'rejected')).not.toThrow();
  });

  it('allows rejected → pending (reopen)', () => {
    expect(() => svc.validateTransition('rejected', 'pending')).not.toThrow();
  });

  it('allows overdue → in_progress / completed / cancelled', () => {
    expect(() => svc.validateTransition('overdue', 'in_progress')).not.toThrow();
    expect(() => svc.validateTransition('overdue', 'completed')).not.toThrow();
    expect(() => svc.validateTransition('overdue', 'cancelled')).not.toThrow();
  });

  it('rejects pending → completed (must start first)', () => {
    expect(() => svc.validateTransition('pending', 'completed')).toThrow(BusinessException);
  });

  it('rejects completed → in_progress (terminal)', () => {
    try {
      svc.validateTransition('completed', 'in_progress');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BusinessException);
      expect((err as BusinessException).code).toBe(ErrorCode.TASK_ALREADY_COMPLETED);
    }
  });

  it('rejects cancelled → anything (terminal)', () => {
    expect(() => svc.validateTransition('cancelled', 'in_progress')).toThrow(BusinessException);
    expect(() => svc.validateTransition('cancelled', 'completed')).toThrow(BusinessException);
  });

  it('rejects same-state transitions', () => {
    expect(() => svc.validateTransition('pending', 'pending')).toThrow(BusinessException);
  });

  it('isTerminal flags completed and cancelled', () => {
    expect(svc.isTerminal('completed')).toBe(true);
    expect(svc.isTerminal('cancelled')).toBe(true);
    expect(svc.isTerminal('pending')).toBe(false);
    expect(svc.isTerminal('rejected')).toBe(false);
    expect(svc.isTerminal('overdue')).toBe(false);
  });

  it('canTransitionTo returns booleans', () => {
    expect(svc.canTransitionTo('pending', 'in_progress')).toBe(true);
    expect(svc.canTransitionTo('pending', 'completed')).toBe(false);
  });

  it('getNextPossibleStatuses lists allowed targets', () => {
    expect(svc.getNextPossibleStatuses('pending').sort()).toEqual(
      ['cancelled', 'in_progress'].sort(),
    );
    expect(svc.getNextPossibleStatuses('completed')).toEqual([]);
  });
});
