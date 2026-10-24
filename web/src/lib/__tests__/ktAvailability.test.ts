import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { KT_UNAVAILABLE_ALERT, reportKtAvailable, reportKtUnavailable } from '../ktAvailability';
import { useSystemStore } from '../../store/systemStore';

const inactive = { active: false, message: '', type: 'info' as const };

const banner = () => useSystemStore.getState().banner;

describe('ktAvailability', () => {
  beforeEach(() => {
    localStorage.clear();
    useSystemStore.setState({ banner: inactive });
  });

  it('shows a warning when the KT monitor fails', () => {
    reportKtUnavailable(new Error('network down'));
    expect(banner()).toMatchObject({
      active: true,
      type: 'warning',
      alertType: KT_UNAVAILABLE_ALERT,
    });
  });

  it('ignores a deliberately disabled KT service', () => {
    reportKtUnavailable(new ApiError(503, 'disabled', { error: 'KT_QUERY_DISABLED' }));
    expect(banner().active).toBe(false);
  });

  it('clears only its own banner when KT recovers', () => {
    reportKtUnavailable(new Error('network down'));
    reportKtAvailable();
    expect(banner().active).toBe(false);
  });

  it('does not overwrite an unrelated active banner', () => {
    const other = { active: true, message: 'maintenance', type: 'info' as const };
    useSystemStore.setState({ banner: other });
    reportKtUnavailable(new Error('network down'));
    expect(banner()).toEqual(other);
  });

  it('stays hidden after the user dismisses it today', () => {
    localStorage.setItem(`nyx_dismissed_${KT_UNAVAILABLE_ALERT}`, new Date().toDateString());
    reportKtUnavailable(new Error('network down'));
    expect(banner().active).toBe(false);
  });
});
