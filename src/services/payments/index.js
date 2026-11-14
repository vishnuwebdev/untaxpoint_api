/**
 * Payment provider layer. Every provider implements:
 *   chargePlatformFunding({ amountCents, currency, reference }) -> { status: 'completed'|'pending'|'failed', providerRef, failureReason? }
 *   sendPayout({ withdrawalId, amountCents, currency, method, destination }) -> same shape
 * The rest of the API never talks to PayPal (or anyone else) directly, so switching
 * from the mock provider to PayPal only means adding payments/paypal.js and setting PAYMENT_PROVIDER.
 */
const crypto = require('node:crypto');
const config = require('../../config');

const mock = {
  name: 'mock',
  async chargePlatformFunding({ amountCents }) {
    return { status: 'completed', providerRef: `mock_charge_${crypto.randomUUID()}`, amountCents };
  },
  // Test hooks: a destination containing "fail" fails, one containing "pending" stays pending.
  async sendPayout({ destination }) {
    const d = String(destination).toLowerCase();
    if (d.includes('fail')) return { status: 'failed', providerRef: `mock_payout_${crypto.randomUUID()}`, failureReason: 'Mock provider rejected the payout' };
    if (d.includes('pending')) return { status: 'pending', providerRef: `mock_payout_${crypto.randomUUID()}` };
    return { status: 'completed', providerRef: `mock_payout_${crypto.randomUUID()}` };
  },
};

const providers = { mock };

function provider() {
  const p = providers[config.paymentProvider];
  if (!p) throw new Error(`Payment provider "${config.paymentProvider}" is not configured yet`);
  return p;
}

module.exports = { provider };
