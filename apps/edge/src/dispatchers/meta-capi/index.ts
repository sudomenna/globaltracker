/**
 * Meta CAPI dispatcher — public API.
 *
 * Re-exports all public symbols for the meta-capi dispatcher module.
 *
 * T-3-001, T-3-002, T-3-003
 */

// Mapper (T-3-001)
export {
  mapEventToMetaPayload,
  type DispatchableEvent,
  type DispatchableLead,
  type MapperContext,
  type MetaCapiPayload,
  type MetaCustomData,
  type MetaUserData,
} from './mapper.js';

// Client (T-3-002)
export {
  classifyMetaCapiError,
  sendToMetaCapi,
  type MetaCapiConfig,
  type MetaCapiResponseBody,
  type MetaCapiResult,
} from './client.js';

// Eligibility (T-3-003)
export {
  checkEligibility,
  type ConsentSnapshot,
  type EligibilityEvent,
  type EligibilityLead,
  type EligibilityResult,
  type MetaLaunchConfig,
  type SkipReason,
} from './eligibility.js';
