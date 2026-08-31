/// <reference path="../.sst/platform/config.d.ts" />

import { isProtectedStage } from './stage';
import { vpc } from './vpc';

/**
 * Postgres (P0-14).
 *
 * Several of the plan's requirements are already SST v4 defaults, verified in
 * `platform/src/components/aws/postgres.ts` at the pinned tag: `storageEncrypted`
 * is true, storage type is gp3, `backupRetentionPeriod` is 7 days, and passing a
 * `Vpc` places the instance in its private subnets. Those are not repeated here.
 *
 * What is set explicitly is everything where SST's default and this plan differ,
 * or where the default is a number the cost model depends on.
 */
export const database = new sst.aws.Postgres('Database', {
  vpc,

  // SST defaults to Postgres 17; §P0-14 specifies 16. Pinned rather than
  // inherited so a future SST default bump cannot move the engine version
  // underneath a database that already holds data.
  version: '16',

  // Both are SST defaults today. Stated anyway: they are the two figures the
  // §5.2a bill is built from, and a silent default change would move the bill
  // without producing a diff here.
  instance: 't4g.micro',
  storage: '20 GB',

  transform: {
    /**
     * Force TLS.
     *
     * SST's generated parameter group ships `rds.force_ssl = "0"`, so without
     * this an unencrypted connection is accepted. The plan requires it to be 1.
     *
     * The function form of `transform` is required here, not the object form:
     * an object is applied as a shallow spread, so passing `parameters` would
     * replace SST's whole array and silently drop the `rds.logical_replication`
     * entry it also sets. This rewrites just the one parameter and leaves the
     * rest as found, so it survives SST changing its own defaults.
     */
    parameterGroup: (args) => {
      args.parameters = $output(args.parameters).apply((existing) => [
        ...(existing ?? []).filter((p) => p.name !== 'rds.force_ssl'),
        { name: 'rds.force_ssl', value: '1' },
      ]);
    },

    /**
     * Deletion protection on stages that hold real data. This is the last stop
     * between a mistyped command and an unrecoverable database; `removal:
     * retain` in `sst.config.ts` guards the stage, this guards the instance.
     */
    instance: (args) => {
      args.deletionProtection = isProtectedStage($app.stage);
    },
  },
});
