import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { BaseBuiltInServer } from '../base'
import { PuppeteerScraper } from '@missionsquad/puppeteer-scraper'
import { log } from '../../utils/general'
import { env } from '../../env'

export class BuiltInSearxngServer extends BaseBuiltInServer {
  name = 'builtin:searxng'
  externalName = 'webtools'
  version = '1.0.0'
  description = 'Built-in SearXNG search and web content retrieval'
  
  private scraper: PuppeteerScraper | null = null
  private scraperReady = false
  private readonly MAX_PUPPETEER_RETRIES = 5
  private readonly INITIAL_RETRY_DELAY_MS = 15000
  
  tools: Tool[]

  constructor() {
    super()
    this.tools = this.getAvailableTools()
  }

  private getAvailableTools(): Tool[] {
    const allTools: Tool[] = [
      {
        name: 'web_search',
        description:
          'Performs a web search using the SearXNG API, ideal for general queries, news, articles, and online content. ' +
          'Use this for broad information gathering, recent events, or when you need diverse web sources.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. This is the main input for the web search'
          },
          pageno: {
            type: 'number',
            description: 'Search page number (starts at 1)',
            default: 1
          },
          count: {
            type: 'number',
            description: 'Number of results per page (default: 10)',
            default: 10
          },
          time_range: {
            type: 'string',
            description: 'Time range of search (day, month, year)',
            enum: ['day', 'month', 'year']
          },
          language: {
            type: 'string',
            description: "Language code for search results (e.g., 'en', 'fr', 'de'). Default is instance-dependent."
          },
          safesearch: {
            type: 'string',
            description: 'Safe search filter level (0: None, 1: Moderate, 2: Strict) (default: 0)',
            enum: ['0', '1', '2']
          }
        },
        required: ['query']
      }
    },
    {
      name: 'get_url_content',
      description:
        'Get the content of a URL. Use this for further information retrieving to understand the content of each URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL'
          }
        },
        required: ['url']
      }
    }
    ]

    // Conditionally include web_search tool
    const searxngUrl = env.SEARXNG_URL
    if (!searxngUrl) {
      log({ level: 'warn', msg: 'SEARXNG_URL not set. The "web_search" tool will be disabled.' })
      return allTools.filter(tool => tool.name !== 'web_search')
    }

    return allTools
  }
  
  async init(): Promise<void> {
    // Start Puppeteer initialization in the background
    this.initializePuppeteerWithRetries()
  }
  
  async stop(): Promise<void> {
    if (this.scraper) {
      try {
        // Puppeteer cleanup would go here
        // Note: PuppeteerScraper needs a cleanup method
        log({ level: 'info', msg: 'Stopped Puppeteer scraper' })
      } catch (error) {
        log({ level: 'error', msg: 'Error stopping Puppeteer scraper', error })
      }
    }
  }
  
  protected async handleToolCall(
    toolName: string, 
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    if (toolName === 'web_search') {
      return this.handleWebSearch(args)
    } else if (toolName === 'get_url_content') {
      return this.handleGetUrlContent(args)
    }
    
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      isError: true
    }
  }
  
  private async handleWebSearch(args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.isSearXNGWebSearchArgs(args)) {
      return {
        content: [{ type: 'text', text: 'Invalid arguments for web_search' }],
        isError: true
      }
    }
    
    const {
      query,
      pageno = 1,
      count = 10,
      time_range,
      language = 'all',
      safesearch
    } = args
    
    try {
      const results = await this.performWebSearch(
        query,
        pageno,
        count,
        time_range,
        language,
        safesearch
      )
      
      return {
        content: [{ type: 'text', text: results }],
        isError: false
      }
    } catch (error) {
      return {
        content: [{ 
          type: 'text', 
          text: `Search error: ${error instanceof Error ? error.message : String(error)}` 
        }],
        isError: true
      }
    }
  }
  
  private async handleGetUrlContent(args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.scraperReady) {
      return {
        content: [{
          type: 'text',
          text: 'Tool not ready: Puppeteer is still initializing. Please try again in a few moments.'
        }],
        isError: true
      }
    }
    
    const { url } = args
    if (typeof url !== 'string') {
      return {
        content: [{ type: 'text', text: 'Invalid URL argument' }],
        isError: true
      }
    }
    
    try {
      const result = await this.fetchAndConvertToMarkdown(url)
      return {
        content: [{ type: 'text', text: result }],
        isError: false
      }
    } catch (error) {
      return {
        content: [{ 
          type: 'text', 
          text: `Fetch error: ${error instanceof Error ? error.message : String(error)}` 
        }],
        isError: true
      }
    }
  }
  
  private isSearXNGWebSearchArgs(args: unknown): args is {
    query: string
    pageno?: number
    count?: number
    time_range?: string
    language?: string
    safesearch?: string
  } {
    return (
      typeof args === 'object' &&
      args !== null &&
      'query' in args &&
      typeof (args as { query: string }).query === 'string'
    )
  }
  
  private async performWebSearch(
    query: string,
    pageno: number = 1,
    count: number = 10,
    time_range?: string,
    language: string = 'all',
    safesearch?: string
  ): Promise<string> {
    const searxngUrl = env.SEARXNG_URL || ''
    const url = new URL(`${searxngUrl}/search`)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('pageno', pageno.toString())
    url.searchParams.set('count', count.toString())
    
    if (time_range !== undefined && ['day', 'month', 'year'].includes(time_range)) {
      url.searchParams.set('time_range', time_range)
    }
    
    if (language && language !== 'all') {
      url.searchParams.set('language', language)
    }
    
    if (safesearch !== undefined && ['0', '1', '2'].includes(safesearch)) {
      url.searchParams.set('safesearch', safesearch)
    }
    
    const response = await fetch(url.toString(), { method: 'GET' })
    
    if (!response.ok) {
      throw new Error(
        `SearXNG API error: ${response.status} ${response.statusText}\n${await response.text()}`
      )
    }
    
    const data = await response.json() as {
      results: Array<{
        title: string
        content: string
        url: string
      }>
    }
    
    const results = (data.results || []).map((result) => ({
      title: result.title || '',
      content: result.content || '',
      url: result.url || ''
    }))
    
    return results
      .map((r) => `Title: ${r.title}\nDescription: ${r.content}\nURL: ${r.url}`)
      .join('\n\n')
  }
  
  private async initializePuppeteerWithRetries(retryCount = 0): Promise<void> {
    try {
      log({ 
        level: 'info', 
        msg: `Starting Puppeteer initialization (Attempt ${retryCount + 1}/${this.MAX_PUPPETEER_RETRIES})...` 
      })
      
      this.scraper = new PuppeteerScraper({
        headless: true,
        ignoreHTTPSErrors: true,
        blockResources: false,
        cacheSize: 1000,
        enableGPU: false
      })
      
      await this.scraper.init()
      this.scraperReady = true
      log({ level: 'info', msg: 'Puppeteer initialized successfully.' })
    } catch (error) {
      log({ 
        level: 'error', 
        msg: `Failed to initialize Puppeteer on attempt ${retryCount + 1}:`, 
        error 
      })
      
      if (retryCount < this.MAX_PUPPETEER_RETRIES - 1) {
        const delay = this.INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount)
        log({ level: 'info', msg: `Retrying in ${delay / 1000} seconds...` })
        setTimeout(() => this.initializePuppeteerWithRetries(retryCount + 1), delay)
      } else {
        log({ 
          level: 'error', 
          msg: 'Max retries reached. Puppeteer initialization failed permanently for this session.' 
        })
      }
    }
  }
  
  private async fetchAndConvertToMarkdown(url: string): Promise<string> {
    if (!this.scraperReady || !this.scraper) {
      throw new Error('Puppeteer is not ready. Please try again in a few moments.')
    }
    
    const response = await this.scraper.scrapePage(url)
    if (response == null) {
      throw new Error(`Failed to fetch the URL: ${url}`)
    }
    
    return response.content.text
  }
}
