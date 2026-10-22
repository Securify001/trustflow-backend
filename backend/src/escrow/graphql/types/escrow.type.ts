import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { MilestoneType } from './milestone.type';

// GraphQL serializes enum members by their keys, so the keys are deliberately the
// lowercase wire values the REST API (and GraphQL clients) already receive.
export enum EscrowStatusGraphQLEnum {
  pending = 'pending',
  active = 'active',
  released = 'released',
  disputed = 'disputed',
  cancelled = 'cancelled',
}

registerEnumType(EscrowStatusGraphQLEnum, {
  name: 'EscrowStatus',
  description: 'Lifecycle status of an escrow',
});

@ObjectType('Escrow')
export class EscrowType {
  @Field(() => ID)
  id!: string;

  @Field()
  depositor!: string;

  @Field()
  beneficiary!: string;

  @Field()
  amountXLM!: string;

  @Field(() => EscrowStatusGraphQLEnum)
  status!: EscrowStatusGraphQLEnum;

  @Field()
  createdAt!: string;

  @Field({ nullable: true })
  contractEscrowId?: string;

  @Field({ nullable: true })
  stellarTxHash?: string;

  @Field({ nullable: true })
  disputeReason?: string;

  @Field({ nullable: true })
  disputedAt?: string;

  @Field({ nullable: true })
  splitPercentage?: number;

  @Field(() => [MilestoneType], { nullable: true })
  milestones?: MilestoneType[];
}
