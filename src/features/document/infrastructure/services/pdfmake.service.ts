import { createRequire } from 'module';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

import type { PdfService } from '../../domain/ports/pdf.service';
import { logger } from '../../../../shared/logger';

const _require = createRequire(import.meta.url);

// ─────────────────────────────────────────────
// Types pdfmake
// ─────────────────────────────────────────────

type PdfMakeInstance = {
  setUrlAccessPolicy: (cb: () => boolean) => void;
  setLocalAccessPolicy: (cb: () => boolean) => void;

  addFonts: (fonts: Record<string, Record<string, string>>) => void;

  virtualfs: {
    writeFileSync(name: string, data: Buffer): void;
  };

  createPdf(doc: TDocumentDefinitions): {
    getBuffer(): Promise<Buffer>;
  };
};

type RobotoModule = {
  fonts: Record<string, Record<string, string>>;

  vfs: Record<
    string,
    | string
    | {
        data: string;
        encoding?: BufferEncoding;
      }
  >;
};

// ─────────────────────────────────────────────
// Lazy loading Vercel compatible
// ─────────────────────────────────────────────

let pdfmake: PdfMakeInstance | null = null;
let Roboto: RobotoModule | null = null;

function loadPdfMake(): void {
  if (pdfmake && Roboto) {
    return;
  }

  pdfmake = _require('pdfmake') as PdfMakeInstance;

  Roboto = _require('pdfmake/build/fonts/Roboto.js') as RobotoModule;
}

// ─────────────────────────────────────────────
// Fonts initialization
// ─────────────────────────────────────────────

let fontsInitialized = false;

function ensureFonts(): void {
  loadPdfMake();

  if (fontsInitialized) {
    return;
  }

  if (!pdfmake || !Roboto) {
    throw new Error('PDFMake initialization failed');
  }

  // Sécurité :
  // empêche pdfmake de charger des ressources externes
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);

  for (const [name, entry] of Object.entries(Roboto.vfs)) {
    const data = typeof entry === 'string' ? entry : entry.data;

    const encoding = typeof entry === 'string' ? 'base64' : (entry.encoding ?? 'base64');

    pdfmake.virtualfs.writeFileSync(name, Buffer.from(data, encoding));
  }

  pdfmake.addFonts(Roboto.fonts);

  fontsInitialized = true;
}

// ─────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────

type TemplateId = 'TPL-contract' | 'TPL-welcome_letter' | 'TPL-certificate' | 'TPL-guide';

function buildWelcomeLetter(data: Record<string, unknown>): TDocumentDefinitions {
  return {
    content: [
      {
        text: 'KISSO INDUSTRIES',
        style: 'header',
        alignment: 'center',
      },

      {
        text: '\nLettre de Bienvenue\n\n',
      },

      {
        text: `Cher(e) ${data.firstName ?? ''} ${data.lastName ?? ''},`,
        style: 'body',
      },

      {
        text: `Nous avons le plaisir de vous accueillir au sein de Kisso Industries, département ${data.department ?? 'N/A'}, en tant que ${data.position ?? 'N/A'}.`,
        style: 'body',
      },

      {
        text: `Votre date de début est le ${data.startDate ?? 'à confirmer'}.`,
        style: 'body',
      },

      {
        text: 'Prochaines étapes :',
        style: 'sectionHeader',
      },

      {
        ul: [
          'Compléter votre profil employé',
          'Rejoindre les canaux Slack assignés',
          'Remplir le questionnaire d’intégration',
          'Consulter le guide onboarding',
        ],
      },

      {
        text: '\nBienvenue dans l’équipe !',
        italics: true,
      },
    ],

    styles: {
      header: {
        fontSize: 22,
        bold: true,
      },

      body: {
        fontSize: 11,
      },

      sectionHeader: {
        fontSize: 13,
        bold: true,
      },
    },

    defaultStyle: {
      font: 'Roboto',
    },
  };
}

function buildContract(data: Record<string, unknown>): TDocumentDefinitions {
  return {
    content: [
      {
        text: 'KISSO INDUSTRIES',
        style: 'header',
      },

      {
        text: 'CONTRAT DE TRAVAIL',
        style: 'header',
      },

      {
        table: {
          widths: ['*', '*'],

          body: [
            ['Employé', `${data.firstName ?? ''} ${data.lastName ?? ''}`],

            ['Email', `${data.email ?? ''}`],

            ['Département', `${data.department ?? ''}`],

            ['Poste', `${data.position ?? ''}`],
          ],
        },
      },
    ],

    styles: {
      header: {
        fontSize: 20,
        bold: true,
      },
    },

    defaultStyle: {
      font: 'Roboto',
    },
  };
}

function buildCertificate(data: Record<string, unknown>): TDocumentDefinitions {
  return {
    content: [
      {
        text: 'CERTIFICAT D’ONBOARDING',
        style: 'header',
      },

      {
        text: `${data.firstName ?? ''} ${data.lastName ?? ''} a complété son onboarding chez Kisso Industries.`,
      },
    ],

    styles: {
      header: {
        fontSize: 22,
        bold: true,
      },
    },

    defaultStyle: {
      font: 'Roboto',
    },
  };
}

function buildGuide(data: Record<string, unknown>): TDocumentDefinitions {
  return {
    content: [
      {
        text: 'GUIDE D’ONBOARDING',
        style: 'header',
      },

      {
        text: `Département : ${data.department ?? 'Général'}`,
      },

      {
        ul: [
          'Configuration poste de travail',
          'Accès Slack/GitHub',
          'Présentation équipe',
          'Culture entreprise',
        ],
      },
    ],

    styles: {
      header: {
        fontSize: 22,
        bold: true,
      },
    },

    defaultStyle: {
      font: 'Roboto',
    },
  };
}

const TEMPLATE_BUILDERS: Record<
  TemplateId,
  (data: Record<string, unknown>) => TDocumentDefinitions
> = {
  'TPL-contract': buildContract,

  'TPL-welcome_letter': buildWelcomeLetter,

  'TPL-certificate': buildCertificate,

  'TPL-guide': buildGuide,
};

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

export class PdfmakeService implements PdfService {
  private outputDir: string;

  constructor(outputDir = './data/documents') {
    this.outputDir = outputDir;
  }

  async generate(employeeData: Record<string, unknown>, templateId: string): Promise<string> {
    const builder = TEMPLATE_BUILDERS[templateId as TemplateId];

    if (!builder) {
      throw new Error(`Unknown template ${templateId}`);
    }

    ensureFonts();

    if (!pdfmake) {
      throw new Error('PDFMake unavailable');
    }

    const pdf = pdfmake.createPdf(builder(employeeData));

    const buffer = await pdf.getBuffer();

    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, {
        recursive: true,
      });
    }

    const filename = `${templateId}_${Date.now()}.pdf`;

    const filepath = join(this.outputDir, filename);

    writeFileSync(filepath, buffer);

    logger.info('PDF generated', {
      filepath,
      templateId,
      size: buffer.length,
    });

    return filepath;
  }
}
