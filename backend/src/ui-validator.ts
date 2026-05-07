import { chromium, Browser, Page } from 'playwright';
import { logger } from './logger';
import { BaselineManager } from './baseline-manager';

export interface UIValidationResult {
  barcode: string;
  found: boolean;
  displayedStatus?: string;
  status: 'PASS' | 'FAIL' | 'HEALED' | 'ERROR';
  reason?: string;
  durationMs: number;
}

export class UIValidator {
  private browser: Browser | null = null;
  private baselineMgr: BaselineManager;

  constructor() {
    this.baselineMgr = new BaselineManager();
  }

  async validateParcelDisplay(
    baseUrl: string,
    barcode: string,
    runId: string,
    commitId: string,
    apiResponse?: any
  ): Promise<UIValidationResult> {
    const startTime = Date.now();
    let page: Page | null = null;

    try {
      if (!this.browser) {
        this.browser = await chromium.launch({ headless: true });
      }

      const context = await this.browser.newContext();
      page = await context.newPage();

      let baseline = await this.baselineMgr.getBaseline(commitId);
      let isNewBaseline = false;

      if (!baseline) {
        isNewBaseline = true;
        baseline = {
          commit_id: commitId,
          selectors: {
            searchInput: 'input[name="search"]',
            statusCell: '.parcel-status'
          },
          expected_steps: [],
          api_mapping: {}
        };
      }

      logger.info(`[UI-VALIDATOR] Logging in to dashboard...`, 'UI-VALIDATOR');
      await page.goto(`http://localhost:7001/FE-CSND/index.php`, { timeout: 15000, waitUntil: 'networkidle' });

      await page.fill('input[name="username"]', process.env.FE_USERNAME || 'adminuser');
      await page.fill('input[name="password"]', process.env.FE_PASSWORD || 'Nido@2023');
      await Promise.all([
        page.waitForURL(/dashboard\.php/, { timeout: 15000 }),
        page.click('button[name="login"]')
      ]);

      await page.goto(baseUrl, { timeout: 15000, waitUntil: 'networkidle' });

      // Search using Baseline selector
      let searchInputSel = baseline.selectors.searchInput;
      let healedSearch = false;
      
      if (await page.locator(searchInputSel).count() === 0) {
        // Self-Healing
        logger.warn(`[UI-VALIDATOR] Primary selector ${searchInputSel} failed. Attempting self-healing...`, 'UI-VALIDATOR');
        const fallbackSelectors = [
          '[data-testid="search-input"]',
          'input[placeholder*="barcode" i]',
          'input[type="search"]'
        ];
        
        for (const fb of fallbackSelectors) {
          if (await page.locator(fb).count() > 0) {
            searchInputSel = fb;
            healedSearch = true;
            logger.info(`[UI-VALIDATOR] Healed search input to ${fb}`, 'UI-VALIDATOR');
            await this.baselineMgr.updateHealedSelector(commitId, 'searchInput', fb);
            break;
          }
        }
        
        if (!healedSearch) throw new Error('Could not heal search input selector');
      }

      await page.locator(searchInputSel).first().fill(barcode);
      await page.keyboard.press('Enter');
      
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);

      // Verify DOM content explicitly (no screenshots)
      const pageContent = await page.content();
      const parcelFound = pageContent.includes(barcode);

      let statusCellSel = baseline.selectors.statusCell;
      let displayedStatus = '';
      let healedStatus = false;

      if (await page.locator(statusCellSel).count() === 0 && parcelFound) {
        // Self-Healing for status cell
        const fallbackSelectors = ['td.status', '.badge', '.status-badge', 'td:has-text("PASS")', 'td:has-text("FAIL")'];
        for (const fb of fallbackSelectors) {
          if (await page.locator(fb).count() > 0) {
            statusCellSel = fb;
            healedStatus = true;
            logger.info(`[UI-VALIDATOR] Healed status cell to ${fb}`, 'UI-VALIDATOR');
            await this.baselineMgr.updateHealedSelector(commitId, 'statusCell', fb);
            break;
          }
        }
      }

      if (await page.locator(statusCellSel).count() > 0) {
        displayedStatus = await page.locator(statusCellSel).first().textContent() || '';
      }

      // API <-> UI Mapping Validation (Phase 6)
      if (apiResponse && apiResponse.status && displayedStatus) {
        if (!displayedStatus.toUpperCase().includes(apiResponse.status.toUpperCase())) {
           throw new Error(`API status ${apiResponse.status} does not match UI status ${displayedStatus}`);
        }
      }

      if (isNewBaseline) {
        await this.baselineMgr.saveBaseline(baseline);
      }

      await context.close();

      return {
        barcode,
        found: parcelFound,
        displayedStatus,
        status: (healedSearch || healedStatus) ? 'HEALED' : (parcelFound ? 'PASS' : 'FAIL'),
        reason: (healedSearch || healedStatus) ? 'Selectors healed dynamically' : 'DOM Assertions passed',
        durationMs: Date.now() - startTime
      };

    } catch (err: any) {
      logger.warn(`[UI-VALIDATOR] Failed for ${barcode}: ${err.message}`, 'UI-VALIDATOR');
      if (page) await page.context().close();
      return { barcode, found: false, status: 'ERROR', reason: err.message, durationMs: Date.now() - startTime };
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}