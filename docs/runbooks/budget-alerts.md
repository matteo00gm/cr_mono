# Budget alerts, and confirming the subscription that makes them real

What to do about the open item that says the cost alerts are silent. Written because the failure is invisible by nature: **no alert and no spend look identical**, and the cost control that makes an always-on NAT and RDS acceptable (§5.8) is currently not connected.

## What is wrong

Both budgets exist on the `dev` stage and the SNS topic is created with them. The subscription to that topic is in `PendingConfirmation`, and AWS delivers nothing to a subscription in that state.

AWS sends a confirmation link to the address when the subscription is created, and the link has to be clicked by a person. There is no API call that confirms a subscription on the subscriber's behalf — that is the whole point of the mechanism, and it is why this cannot be closed by a deploy.

## What it costs to leave

§5.8's argument for an always-on NAT (~$13/month) and an always-on RDS instance is that the budget alerts catch a runaway before it becomes a bill worth caring about. Without a confirmed subscription that argument does not hold, and the first anyone learns of a problem is the invoice.

It is worth being precise about what a runaway looks like here: the plan cap (P2-36) bounds what a _tenant_ can spend, and the per-minute limits (P2-04) bound a burst. Neither bounds a mistake of ours — a loop that re-embeds a catalogue, a stage left running, a model swapped for one costing fifty times as much. Those are what the budget is for.

## The fix

1. **Find the subscription.**

   ```bash
   aws sns list-subscriptions --region eu-west-1 --output table
   ```

   Look for one whose `SubscriptionArn` is the literal string `PendingConfirmation` rather than an ARN.

2. **Open the mailbox for the address on that subscription** and click the confirmation link in the message from AWS Notifications. The subject is _"AWS Notification - Subscription Confirmation"_.

   If the message is not there, it has expired — AWS confirmation links are valid for three days. Re-send it:

   ```bash
   aws sns subscribe \
     --region eu-west-1 \
     --topic-arn <the topic arn> \
     --protocol email \
     --notification-endpoint <the address>
   ```

3. **Check it took.** The same `list-subscriptions` call now shows a real ARN where `PendingConfirmation` was.

4. **Prove it delivers**, because a confirmed subscription that cannot deliver is the same silence with more steps:

   ```bash
   aws sns publish \
     --region eu-west-1 \
     --topic-arn <the topic arn> \
     --subject "budget alert test" \
     --message "Ignore: confirming the budget topic delivers."
   ```

   A message that does not arrive within a minute is a delivery problem, not a confirmation problem — check the address, and check the account's SNS delivery status logs.

## After creating any new stage

**Every stage creates its own budgets and its own topic**, so every stage creates its own `PendingConfirmation`. A new stage with unconfirmed alerts is a stage with no cost control, and it is the same silence.

So this is not a one-off: re-run step 1 after `sst deploy --stage <new>`, and confirm what it finds.

## Why this is not automated

It could be, by subscribing a mailbox we control and confirming programmatically from it. That is a mail-handling component, a set of credentials and an inbox to operate, for an action a person takes once per stage in under a minute. Revisit if the number of stages ever makes it a chore rather than a step.

## Related

- The open item in [`plan-v1.md`](../../plan-v1.md) that points here.
- §5.8 for the budget figures and the argument they support.
