/// <reference path="../.sst/platform/config.d.ts" />

import { wafAclArgs } from './waf-rules';

/**
 * The WAF web ACL in front of CloudFront (P4-13). The rules are data in
 * `waf-rules.ts`; this file only places them.
 *
 * **In `us-east-1`, whatever the stack's region.** AWS accepts a
 * `CLOUDFRONT`-scoped web ACL there and nowhere else, so it gets a provider of
 * its own rather than the stack's `eu-west-1` default.
 */
const usEast1 = new aws.Provider('WafUsEast1', { region: 'us-east-1' });

export const webAcl = new aws.wafv2.WebAcl('EdgeWaf', wafAclArgs(), { provider: usEast1 });
