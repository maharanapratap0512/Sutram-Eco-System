'use strict';

const express = require('express');

/**
 * VisionRouter
 * Creates Express Router for SutramVision REST APIs.
 */
class VisionRouter {
  static create(visionInstance) {
    const router = express.Router();

    // Middleware to extract credentials from headers or active database sys_meta
    const extractHeaderCreds = req => {
      let provider = req.headers['x-vlm-provider'] || req.body?.provider || 'gemini';
      let apiKey = req.headers['x-vlm-api-key'] || req.body?.apiKey;
      let model = req.headers['x-vlm-model'] || req.body?.model;
      let endpoint = req.headers['x-vlm-endpoint'] || req.body?.endpoint;
      const mode = req.headers['x-vlm-mode'] || req.body?.mode || 'normal';

      let profiles = req.body?.apiProfiles || [];

      // Fallback: If no apiKey was sent from frontend, read profiles directly from database sys_meta
      if (!apiKey && req.projectDb) {
        try {
          const row = req.projectDb.prepare(`SELECT value FROM sys_meta WHERE key = 'vision_profiles'`).get();
          if (row && row.value) {
            const dbProfiles = JSON.parse(row.value);
            if (Array.isArray(dbProfiles) && dbProfiles.length > 0) {
              profiles = dbProfiles;
              const def = dbProfiles.find(p => p.isDefault) || dbProfiles[0];
              if (def) {
                apiKey = def.apiKey;
                provider = def.provider || provider;
                model = def.model || model;
                endpoint = def.endpoint || endpoint;
              }
            }
          }
        } catch (e) {
          // Ignore database read errors
        }
      }

      if (profiles.length === 0 && apiKey) {
        profiles = [{ id: 'header_default', label: 'Active Profile', provider, apiKey, model, endpoint }];
      }

      return { provider, apiKey, model, endpoint, mode, profiles };
    };

    /**
     * GET /status
     */
    router.get('/status', (req, res) => {
      res.json({
        success: true,
        service: 'SutramVision',
        version: '1.0.0-beta.1',
        cacheEntries: visionInstance.cache.size,
        learnedCorrections: visionInstance.memory.corrections.size
      });
    });

    /**
     * GET /profiles
     * Load vision profiles persisted in active database sys_meta
     */
    router.get('/profiles', (req, res) => {
      try {
        if (req.projectDb) {
          const row = req.projectDb.prepare(`SELECT value FROM sys_meta WHERE key = 'vision_profiles'`).get();
          if (row && row.value) {
            return res.json({ success: true, profiles: JSON.parse(row.value), source: 'database' });
          }
        }
        return res.json({ success: true, profiles: [], source: 'none' });
      } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
    });

    /**
     * POST /profiles
     * Persist vision profiles directly to active database sys_meta
     */
    router.post('/profiles', (req, res) => {
      try {
        const { profiles } = req.body;
        if (!Array.isArray(profiles)) {
          return res.status(400).json({ success: false, message: 'profiles must be an array' });
        }
        if (req.projectDb) {
          req.projectDb.prepare(`
            INSERT INTO sys_meta (key, value)
            VALUES ('vision_profiles', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).run(JSON.stringify(profiles));
          return res.json({ success: true, message: 'Vision profiles saved in database sys_meta' });
        }
        return res.json({ success: false, message: 'No active project database found' });
      } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
    });

    /**
     * POST /test-connection
     */
    router.post('/test-connection', async (req, res) => {
      try {
        const { provider = 'gemini', apiKey, model, endpoint } = req.body;
        const testRes = await visionInstance.testConnection(provider, { apiKey, model, endpoint });
        res.json(testRes);
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    /**
     * POST /extract
     */
    router.post('/extract', async (req, res) => {
      try {
        const creds = extractHeaderCreds(req);
        const {
          image,
          imageBase64,
          documentType = 'tabular_register',
          mode = creds.mode || 'normal',
          targetColumns = [],
          masterVocabulary = [],
          autoRotate = true,
          options = {}
        } = req.body;

        const imgData = imageBase64 || image;
        if (!imgData) {
          return res.status(400).json({ success: false, message: 'Image data is required (imageBase64).' });
        }

        const result = await visionInstance.extract({
          imageBase64: imgData,
          documentType,
          mode,
          targetColumns,
          masterVocabulary,
          apiProfiles: creds.profiles,
          autoRotate,
          options: {
            ...options,
            provider: creds.provider,
            apiKey: creds.apiKey,
            model: creds.model,
            endpoint: creds.endpoint
          }
        });

        res.json(result);
      } catch (err) {
        console.error('❌ [sutramVision] /extract error:', err.message);
        res.status(err.status || 500).json({
          success: false,
          message: err.message,
          isRateLimit: err.isRateLimit || false,
          details: err.details || null
        });
      }
    });

    /**
     * POST /batch-extract
     */
    router.post('/batch-extract', async (req, res) => {
      try {
        const creds = extractHeaderCreds(req);
        const {
          images = [],
          documentType = 'tabular_register',
          mode = creds.mode || 'normal',
          targetColumns = [],
          masterVocabulary = [],
          autoRotate = true,
          options = {}
        } = req.body;

        if (!Array.isArray(images) || images.length === 0) {
          return res.status(400).json({ success: false, message: 'Array of images is required.' });
        }

        // True Bulk VLM Merging (All images sent in 1 single VLM API call to save tokens and avoid RPM limits)
        if (req.body.bulkMerged !== false) {
          const bulkMergedResult = await visionInstance.bulkExtractMerged(images, {
            documentType,
            mode,
            targetColumns,
            masterVocabulary,
            apiProfiles: creds.profiles,
            autoRotate,
            options: {
              ...options,
              provider: creds.provider,
              apiKey: creds.apiKey,
              model: creds.model,
              endpoint: creds.endpoint
            }
          });
          return res.json(bulkMergedResult);
        }

        // Fallback: Sequential image processing
        const batchResult = await visionInstance.batchExtract(images, {
          documentType,
          mode,
          targetColumns,
          masterVocabulary,
          apiProfiles: creds.profiles,
          autoRotate,
          options: {
            ...options,
            provider: creds.provider,
            apiKey: creds.apiKey,
            model: creds.model,
            endpoint: creds.endpoint
          }
        });

        res.json(batchResult);
      } catch (err) {
        console.error('❌ [sutramVision] /batch-extract error:', err.message);
        res.status(err.status || 500).json({ success: false, message: err.message });
      }
    });

    /**
     * POST /corrections/save
     */
    router.post('/corrections/save', (req, res) => {
      try {
        const { original_ocr, corrected, field, table } = req.body;
        const saved = visionInstance.memory.addCorrection({ original_ocr, corrected, field, table });
        res.json({ success: true, saved });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    /**
     * GET /corrections
     */
    router.get('/corrections', (req, res) => {
      try {
        const table = req.query.table || 'default';
        const limit = parseInt(req.query.limit, 10) || 20;
        const list = visionInstance.memory.getCorrections(table, limit);
        res.json({ success: true, count: list.length, corrections: list });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    return router;
  }
}

module.exports = VisionRouter;
