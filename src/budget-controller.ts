import { DurableObject } from 'cloudflare:workers';
import type { Env } from './room';
import { billingControl, runBudgetGuard } from './budget';

// Serialize billing alerts, operator recovery and Cron so a stale Cron cannot reopen a billing stop.
export class BudgetController extends DurableObject<Env> {
  async run(action:'sample'|'stop'|'restore') {
    return this.ctx.blockConcurrencyWhile(async()=>{
      const latched=await this.ctx.storage.get<boolean>('billing-latch');
      if(action==='stop') await this.ctx.storage.put('billing-latch',true);
      if(action==='stop'||action==='sample'&&latched) return billingControl(this.env);
      if(action==='restore') {
        const result=await billingControl(this.env,true);
        await this.ctx.storage.delete('billing-latch');
        return result;
      }
      return runBudgetGuard(this.env);
    });
  }
}
