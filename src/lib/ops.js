// Operations is connected by the local server, never by an end-user login.
import { serverRequest } from './server-request.js';
export {
  COLUMNS, assertNoPayColumns, MANAGER_ROLES, VALIDATOR_COLUMNS, projectValidatorRow,
} from './ops-schema.js';

export async function getSchedule({ request = serverRequest } = {}) {
  try {
    return await request('/api/operations');
  } catch {
    return { ok: false, reason: 'Operations data is temporarily unavailable.',
      roles: [], staff: [], sessions: [], assignments: [], validator: { ok: false, rows: [] } };
  }
}
