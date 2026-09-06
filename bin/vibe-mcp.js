#!/usr/bin/env node
/**
 * Точка входа MCP-сервера панели. Запускается клиентом (агентом) сам,
 * общается по stdio. Регистрация: ~/.workbuddy-ai/mcp.json → mcpServers.vibe.
 *
 * Ручной прогон: node bin/vibe-mcp.js < request.jsonl
 */

import { startMcpServer } from '../src/mcp.js';

startMcpServer();
