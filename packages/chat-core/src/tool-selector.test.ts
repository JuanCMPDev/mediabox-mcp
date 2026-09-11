import { describe, expect, it } from 'vitest';
import { selectTools, heuristicPhase } from './tool-selector.js';
import type { ChatMessage } from './types.js';

function names(message: string, history: ChatMessage[] = []): string[] {
  return selectTools(message, history).map(t => t.name);
}

describe('selectTools', () => {
  it('keeps server status turns narrow', () => {
    expect(names('estado del servidor')).toEqual(['server_info', 'present_choices']);
  });

  it('grounds general media existence questions in both Arr catalogs', () => {
    expect(names('Tengo The Bear?')).toEqual(['media_query', 'catalog', 'series', 'movies', 'present_choices']);
  });

  it('treats generic add requests as media catalog work', () => {
    expect(names('Agrega Dragon Ball')).toEqual(['media_query', 'catalog', 'series', 'movies', 'present_choices']);
  });

  it('treats generic download requests as catalog plus download work', () => {
    expect(names('Baja Naruto')).toEqual(['media_query', 'catalog', 'series', 'movies', 'downloads', 'present_choices']);
  });

  it('routes movie downloads through movie, media, and download tools', () => {
    expect(names('Descarga la pelicula Inception')).toEqual([
      'media_query',
      'catalog',
      'movies',
      'downloads',
      'present_choices',
    ]);
  });

  it('routes episode replacement through files, media, and series tools', () => {
    expect(names('Reemplaza el episodio S04E06 de Mr Robot con version latina')).toEqual([
      'media_query',
      'catalog',
      'library_ops',
      'series',
      'present_choices',
    ]);
  });

  it('uses recent tool context for bare confirmations', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'Borra The Show' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'library_ops', args: { action: 'delete' } }] },
      { role: 'user', content: '', toolResults: [{ id: '1', name: 'library_ops', result: '{"requiresConfirmation":true}' }] },
      { role: 'assistant', content: 'Vista previa. Confirmas?' },
      { role: 'user', content: 'si' },
    ];

    expect(names('si', history)).toEqual(['media_query', 'library_ops', 'present_choices']);
  });

  it('keeps a broad fallback for bare confirmations without history', () => {
    expect(names('dale')).toEqual([
      'media_query',
      'catalog',
      'library_ops',
      'series',
      'movies',
      'downloads',
      'media_format',
      'maintenance',
      'operations',
      'present_choices',
    ]);
  });
});

describe('heuristicPhase (§2.3)', () => {
  it('detects orient phase for server and general status queries', () => {
    expect(heuristicPhase('estado del servidor')).toBe('orient');
    expect(heuristicPhase('hola')).toBe('orient');
  });

  it('detects discover phase for search and download requests', () => {
    expect(heuristicPhase('busca la pelicula Inception')).toBe('discover');
    expect(heuristicPhase('descarga Dark temporada 1')).toBe('discover');
  });

  it('detects select phase when mediaRef is present', () => {
    expect(heuristicPhase('ver opciones para mref_1234567890ab')).toBe('select');
  });

  it('detects propose phase when releaseRef is present', () => {
    expect(heuristicPhase('descargar release rref_abcdef123456')).toBe('propose');
  });

  it('detects maintain phase for cleanup / orphan queries', () => {
    expect(heuristicPhase('limpiar archivos huerfanos y temporales')).toBe('maintain');
  });
});
