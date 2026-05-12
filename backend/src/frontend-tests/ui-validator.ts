import { chromium, Browser, Page } from 'playwright';
import { logger } from '../core/logger';
import { BaselineManager } from '../core/baseline-manager';

export interface UIValidationResult {
  barcode: string;
  found: boolean;
  displayedStatus?: string;
  displayedRejectionCode?: string;
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

    const feHost = process.env.VM_HOST || '192.168.5.216';

    try {
      if (!this.browser) {
        this.browser = await chromium.launch({ headless: true });
      }

      const context = await this.browser.newContext();
      page = await context.newPage();

      // ─────────────────────────────────────────────────
      // LOGIN
      // Login is at /index.php (root), NOT /FE-CSND/index.php
      // Form uses input[name="username"] with type="name"
      // (unknown type, browser treats as text)
      // Submit button: button[name="login"]
      // On success, JS redirects to /CL0003/dashboard.php
      // ─────────────────────────────────────────────────
      logger.info(`[UI-VALIDATOR] Logging in to dashboard...`, 'UI-VALIDATOR');

      await page.goto(
        `http://${feHost}:7001/index.php`,
        { timeout: 20000, waitUntil: 'domcontentloaded' }
      );

      // Confirm we actually landed on the login page
      const onLoginPage = await page.locator('input[name="username"]').count() > 0;
      if (!onLoginPage) {
        // Already logged in (session cookie still alive) — skip login
        logger.info(`[UI-VALIDATOR] Already authenticated, skipping login.`, 'UI-VALIDATOR');
      } else {
        await page.fill('input[name="username"]', process.env.FE_USERNAME || 'adminuser');
        await page.fill('input[name="password"]', process.env.FE_PASSWORD || 'Nido@2023');
        await Promise.all([
          page.waitForURL(/dashboard/, { timeout: 20000 }),
          page.click('button[name="login"]')
        ]);
      }

      logger.info(`[UI-VALIDATOR] Navigating to Master Search...`, 'UI-VALIDATOR');

      // ─────────────────────────────────────────────────
      // NAVIGATE TO MASTER SEARCH
      // baseUrl should be: http://{vmHost}:7001/CL0003/master_search.php
      // master_search.php session-checks against $_SESSION['alogin']
      // and redirects to ../index.php if not logged in
      // ─────────────────────────────────────────────────
      await page.goto(baseUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });

      // Guard: if we got redirected back to login, session failed
      if (page.url().includes('index.php')) {
        throw new Error(
          `Session not established — redirected to login after navigating to ${baseUrl}`
        );
      }

      // Wait for AJAX initial table load to complete
      await page.waitForFunction(
        () => {
          const body = document.querySelector('#tableBody');
          return body && !body.textContent?.includes('Loading...');
        },
        { timeout: 15000 }
      );

      // ─────────────────────────────────────────────────
      // SEARCH FOR BARCODE
      // AWB field: input[name="awb"] / input#awb
      // Submit:    button[name="submit"]
      // ─────────────────────────────────────────────────
      let searchInputSel = 'input[name="awb"]';
      let healedSearch = false;

      if (await page.locator(searchInputSel).count() === 0) {
        logger.warn(
          `[UI-VALIDATOR] Primary selector ${searchInputSel} failed. Attempting self-healing...`,
          'UI-VALIDATOR'
        );

        const fallbackSelectors = [
          'input#awb',
          'input[placeholder="AWB No."]',
          'input[placeholder*="AWB" i]',
          'input[placeholder*="barcode" i]',
          'input[type="text"]:first-of-type'
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

      // The jQuery form submit handler intercepts $("form[name='chngpwd']").submit(...)
      // and calls fetchData() — clicking button[name="submit"] triggers it
      await page.click('button[name="submit"]');

      // Wait for AJAX response — tableBody stops saying "Loading..."
      await page.waitForFunction(
        () => {
          const body = document.querySelector('#tableBody');
          return body && !body.textContent?.includes('Loading...');
        },
        { timeout: 15000 }
      );

      await page.waitForTimeout(400);

      // ─────────────────────────────────────────────────
      // FIND BARCODE ROW
      // JS renderer sets data-barcode on each <tr>
      // ─────────────────────────────────────────────────
      const rowSelector = `tr[data-barcode="${barcode}"]`;
      const rowCount = await page.locator(rowSelector).count();
      const parcelFound = rowCount > 0;

      let displayedStatus = '';
      let displayedRejectionCode = '';

      if (parcelFound) {
        // Read header labels to find column indices dynamically
        // Headers have hidden-col class on some — allTextContents() still returns
        // text for hidden elements, so index is reliable
        const allHeaders = await page.locator('#tableHead th').allTextContents();

        const statusIdx = allHeaders.findIndex(
          h => h.trim().toLowerCase() === 'status'
        );
        const rejIdx = allHeaders.findIndex(
          h => h.trim().toLowerCase().includes('rejection code')
        );

        const tds = page.locator(`${rowSelector} td`);

        if (statusIdx >= 0) {
          displayedStatus = (await tds.nth(statusIdx).textContent() || '').trim();
        }

        if (rejIdx >= 0) {
          displayedRejectionCode = (await tds.nth(rejIdx).textContent() || '').trim();
        }

        // Fallback: Status is the 6th visible column in master_search
        if (!displayedStatus) {
          const fallback = `${rowSelector} td:nth-child(6)`;
          if (await page.locator(fallback).count() > 0) {
            displayedStatus = (await page.locator(fallback).textContent() || '').trim();
          }
        }

        logger.info(
          `[UI-VALIDATOR] ${barcode} found → Status: "${displayedStatus}" | Rejection: "${displayedRejectionCode}"`,
          'UI-VALIDATOR'
        );

      } else {
        const pageContent = await page.content();
        const noRecords = pageContent.includes('No records found');
        logger.warn(
          `[UI-VALIDATOR] ${barcode} NOT found in Master Search. No records shown: ${noRecords}`,
          'UI-VALIDATOR'
        );
      }

      // ─────────────────────────────────────────────────
      // API <-> UI STATUS MAPPING
      // apiResponse.status is PASS/FAIL
      // UI shows: Rejected / Confirmed / Accepted / Sorted
      // ─────────────────────────────────────────────────
      if (apiResponse?.status && displayedStatus) {
        const uiStatus = displayedStatus.trim().toUpperCase();
        const apiStatus = apiResponse.status.toUpperCase();

        const isMatch =
          (apiStatus === 'FAIL' && uiStatus === 'REJECTED') ||
          (apiStatus === 'PASS' && ['CONFIRMED', 'ACCEPTED', 'SORTED'].includes(uiStatus));

        if (!isMatch) {
          throw new Error(
            `API status "${apiResponse.status}" does not match UI status "${displayedStatus}"`
          );
        }
      }

      await context.close();

      return {
        barcode,
        found: parcelFound,
        displayedStatus,
        displayedRejectionCode,
        status: healedSearch ? 'HEALED' : (parcelFound ? 'PASS' : 'FAIL'),
        reason: healedSearch
          ? 'Search selector healed dynamically'
          : parcelFound
            ? `Found in UI — Status: ${displayedStatus}, Rejection: ${displayedRejectionCode}`
            : 'Barcode not found in Master Search results',
        durationMs: Date.now() - startTime
      };

    } catch (err: any) {
      logger.warn(`[UI-VALIDATOR] Failed for ${barcode}: ${err.message}`, 'UI-VALIDATOR');
      if (page) await page.context().close();
      return {
        barcode,
        found: false,
        status: 'ERROR',
        reason: err.message,
        durationMs: Date.now() - startTime
      };
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}