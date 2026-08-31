/// <reference path="../.sst/platform/config.d.ts" />

/**
 * VPC (P0-12).
 *
 * The whole point of this file is one option: `nat: "ec2"`. The default
 * `sst.aws.Vpc` provisions a managed NAT Gateway *per AZ* at roughly
 * $32/month each — with two AZs that is ~$64/month, the single largest
 * avoidable line in the stack (§5.1), before any traffic charges.
 *
 * `nat: "ec2"` instead launches one EC2 instance running the fck-nat AMI,
 * defaulting to `t4g.nano` (~$4/month). Verified against the SST v4.17.1
 * source: `platform/src/components/aws/vpc.ts` creates `ec2.NatGateway`
 * resources only when the NAT type is `"managed"`, so this configuration
 * provisions zero of them. That is the budget guarantee, established from
 * source rather than inferred from a deploy.
 *
 * This also delivers what P0-13 describes — fck-nat on t4g.nano with routing
 * for the private subnets — because SST's own EC2 NAT path is exactly that.
 * P0-13 should be re-read as a verification task, not a build task.
 */
export const vpc = new sst.aws.Vpc('Vpc', {
  // RDS needs a subnet group spanning two AZs, so two is the floor rather
  // than a tuning choice. Stated explicitly instead of relying on the default,
  // because a change in that default would silently break the database.
  az: 2,

  // See above. Never "managed".
  //
  // The instance type is stated explicitly rather than inherited. It is the
  // number the cost model rests on, and a change to SST's default would move
  // the bill without changing a line of this repo.
  //
  // Two things this does NOT give us, both verified against the pinned source
  // rather than assumed — see P0-13:
  //   1. One instance PER AZ, not one total. With az: 2 that is two t4g.nano
  //      (~$6-7/month), not the ~$3-4 the plan's single-NAT model assumes.
  //   2. No auto-replacement. SST creates a bare ec2.Instance, not an ASG, so
  //      a dead NAT means private-subnet egress stays down — Stripe, Resend and
  //      domain verification all fail — until someone intervenes.
  nat: {
    ec2: { instance: 't4g.nano' },
  },
});
