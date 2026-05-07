import { logger } from './logger';

export type AlertSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM';

export interface Alert {
  severity: AlertSeverity;
  message: string;
  timestamp: string;
}

export class AlertEngine {
  private alerts: Alert[] = [];
  private emitCallback?: (alert: Alert) => void;

  setEmitter(callback: (alert: Alert) => void) {
    this.emitCallback = callback;
  }

  triggerAlert(severity: AlertSeverity, message: string) {
    const alert: Alert = { severity, message, timestamp: new Date().toISOString() };
    this.alerts.push(alert);
    logger.error(`[ALERT] [${severity}] ${message}`, 'ALERT-ENGINE');
    if (this.emitCallback) {
      this.emitCallback(alert);
    }
  }

  getAlerts(): Alert[] {
    return this.alerts;
  }

  checkSystemHealth(services: any[], dbLatency: number) {
    const criticalServices = ['incoming-service', 'validation-engine', 'inspectra-db'];
    
    services.forEach(s => {
      if (criticalServices.includes(s.name) && s.status === 'DOWN') {
        this.triggerAlert('CRITICAL', `${s.name} is down.`);
      } else if (s.status === 'DOWN') {
        this.triggerAlert('HIGH', `${s.name} is down.`);
      }
    });

    if (dbLatency > 1000) {
      this.triggerAlert('MEDIUM', `Latency spike: DB response time is ${dbLatency}ms.`);
    }
  }
}
