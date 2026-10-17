/// <reference path="../.sst/platform/config.d.ts" />

import { alertEmail } from './budgets';

/**
 * Where an alarm goes (P7-02).
 *
 * **Email, to the address the budget alarm already goes to.** A pager is
 * premature at two wineries, and a second secret for the same inbox is one
 * more thing to forget to set; the day the two should differ is the day this
 * takes a secret of its own.
 *
 * Its own topic rather than the budget's: that one is written to by AWS
 * Budgets under a policy that names it, and "the bill is high" and "the API is
 * down" are subscribed to differently the moment anybody else is on call.
 *
 * **A file with nothing in it but the topic**, because every file that declares
 * an alarm imports this, and `alarms.ts` imports every one of those.
 */
const topic = new aws.sns.Topic('Alarms', {
  displayName: `sommelier-${$app.stage}-alarms`,
});

new aws.sns.TopicSubscription('AlarmsEmail', {
  topic: topic.arn,
  protocol: 'email',
  endpoint: alertEmail.value,
});

/**
 * Spread into every alarm: told when it fires, and told when it clears.
 *
 * The second half matters as much as the first. An alarm that only ever says
 * "wrong" leaves whoever read the email to go and find out whether it still is.
 *
 * Not on insufficient data. Each alarm says what a missing datapoint means for
 * it — healthy for a queue that is empty, broken for a job that never ran — so
 * by the time one would be "insufficient" it is already one or the other.
 */
export const notify = {
  alarmActions: [topic.arn],
  okActions: [topic.arn],
};
