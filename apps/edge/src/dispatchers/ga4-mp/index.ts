/**
 * GA4 Measurement Protocol dispatcher — public API.
 *
 * Re-exports all public symbols for the ga4-mp dispatcher module.
 *
 * T-4-004
 */

// Client-id resolver
export {
  resolveClientId,
  type ClientIdUserData,
} from './client-id-resolver.js';

// Mapper (T-4-004)
export {
  mapEventToGa4Payload,
  type ConsentSnapshot,
  type Ga4DispatchableEvent,
  type Ga4DispatchableLead,
  type Ga4Event,
  type Ga4EventParams,
  type Ga4MapperContext,
  type Ga4MpPayload,
  type Ga4ConsentSignal,
} from './mapper.js';

// Client (T-4-004)
export {
  classifyGa4Error,
  sendToGa4,
  type Ga4Config,
  type Ga4Result,
} from './client.js';

// Eligibility (T-4-004)
export {
  checkEligibility,
  type EligibilityResult,
  type Ga4EligibilityEvent,
  type Ga4SkipReason,
} from './eligibility.js';
