import axios from 'axios';
import { logger } from '../core/logger';

export type PipelineStage = 'hardware' | 'incoming' | 'mapper' | 'posting';

export class PipelineSimulator {
  private serviceBaseUrls = {
    incoming: process.env.INCOMING_SERVICE_URL || 'http://localhost:3001',
    mapper: process.env.MAPPER_SERVICE_URL || 'http://localhost:3002',
    posting: process.env.POSTING_SERVICE_URL || 'http://localhost:3003',
  };

  /**
   * Inject data into the Incoming Service (Dynamic Push)
   */
  async injectToIncoming(payload: any, endpoint: string = '/api/push-data') {
    const url = `${this.serviceBaseUrls.incoming}${endpoint}`;
    logger.info(`Injecting to Incoming: ${url}`, 'PIPELINE');
    return axios.post(url, payload);
  }

  /**
   * Inject data directly to Mapper Service
   */
  async injectToMapper(items: any[], configId?: string) {
    const url = `${this.serviceBaseUrls.mapper}/api/map${configId ? `/${configId}` : ''}`;
    logger.info(`Injecting to Mapper: ${url}`, 'PIPELINE');
    return axios.post(url, { items });
  }

  /**
   * Inject data directly to Data Posting Service
   */
  async injectToPosting(packages: any[], configId: string = 'DEFAULT') {
    const url = `${this.serviceBaseUrls.posting}/api/upload-packages`;
    logger.info(`Injecting to Posting: ${url}`, 'PIPELINE');
    return axios.post(url, { configId, packages, machineConfig: { machine_id: 'MA01' } });
  }

  /**
   * Helper to generate a realistic "Resolved" payload for Mapper
   */
  generateResolvedPayload(barcode: string) {
    return {
      barcode,
      weight: (Math.random() * 5).toFixed(2),
      length: 300,
      width: 200,
      height: 100,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Helper to generate a "Mapped" package for Posting
   */
  generateMappedPackage(barcode: string) {
    return {
      awb_number: barcode,
      client_payload: {
        tracking_number: barcode,
        weight_kg: 1.5,
        dimensions: "30x20x10"
      },
      metadata: {
        sorter_id: "MA01",
        chute_id: "CH05"
      }
    };
  }
}
