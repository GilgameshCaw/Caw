import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class RawEvent {
  @PrimaryGeneratedColumn()
  id?: number;  // Mark id as optional

  @Column({ type: 'bigint' })
  i!: number;

  @Column({ type: 'bigint' })
  blockNumber!: number;

  @Column({ type: 'varchar', length: 66 })
  txHash!: string;

  @Column({ type: 'timestamptz' })
  blockTime!: Date;

  @Column({ type: 'bytea' })
  data!: Buffer;

  @Column({ type: 'varchar', length: 66 })
  parentHash!: string;
}

