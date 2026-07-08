import { NoopErrorTrackingService } from '../noop-error-tracking.service';

describe('NoopErrorTrackingService', () => {
  const svc = new NoopErrorTrackingService();

  it('every operation is a safe no-op', () => {
    expect(() => svc.captureException(new Error('boom'))).not.toThrow();
    expect(() => svc.captureMessage('hello', 'info')).not.toThrow();
    expect(() => svc.setUser({ id: 'u1' })).not.toThrow();
    expect(() => svc.clearUser()).not.toThrow();
    expect(() => svc.addBreadcrumb({ message: 'b', category: 'c', level: 'info' })).not.toThrow();
    expect(() => svc.setTag('k', 'v')).not.toThrow();
    expect(() => svc.setContext('ctx', { a: 1 })).not.toThrow();
  });
});
