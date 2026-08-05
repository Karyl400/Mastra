import { createRequire } from 'module';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { PdfService } from '../../domain/ports/pdf.service';
import { logger } from '../../../../shared/logger';

const _require = createRequire(import.meta.url);

type PdfMakeInstance = {
  setUrlAccessPolicy: (cb: () => boolean) => void;
  setLocalAccessPolicy: (cb: () => boolean) => void;
  addFonts: (fonts: Record<string, Record<string, string>>) => void;
  virtualfs: {
    writeFileSync: (name: string, data: Buffer) => void;
  };
  createPdf: (doc: TDocumentDefinitions) => {
    getBuffer: () => Promise<Buffer>;
  };
};

type RobotoModule = {
  fonts: Record<string, Record<string, string>>;
  vfs: Record<string, string | { data: string; encoding?: BufferEncoding }>;
};

const pdfmake = _require('pdfmake') as PdfMakeInstance;
const Roboto = _require('pdfmake/build/fonts/Roboto.js') as RobotoModule;

let fontsInitialized = false;

function ensureFonts(): void {
  if (fontsInitialized) return;

  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);

  for (const [name, entry] of Object.entries(Roboto.vfs)) {
    const data = typeof entry === 'string' ? entry : entry.data;
    const encoding =
      typeof entry === 'string' ? 'base64' : (entry.encoding ?? 'base64');
    pdfmake.virtualfs.writeFileSync(name, Buffer.from(data, encoding));
  }

  pdfmake.addFonts(Roboto.fonts);
  fontsInitialized = true;
}

type TemplateId = 'TPL-contract' | 'TPL-welcome_letter' | 'TPL-certificate' | 'TPL-guide';

function buildWelcomeLetter(data: Record<string, unknown>): TDocumentDefinitions {
  return {
    content: [
      { text: 'KISSO INDUSTRIES', style: 'header', alignment: 'center' as const },
      { text: '\n' },
      { text: 'Lettre de Bienvenue', style: 'subheader', alignment: 'center' as const },
      { text: '\n\n' },
      {
        text: `Cher(e) ${data.firstName ?? ''} ${data.lastName ?? ''},`,
        style: 'body',
      },
      { text: '\n' },
      {
        text: `Nous avons le plaisir de vous accueillir au sein de Kisso Industries, département ${data.department ?? 'N/A'}, en tant que ${data.position ?? 'N/A'}.`,
        style: 'body',
      },
      { text: '\n' },
      {
        text: `Votre date de début est le ${data.startDate ?? 'à confirmer'}. Vous trouverez ci-dessous les informations essentielles pour votre première semaine.`,
        style: 'body',
      },
      { text: '\n\n' },
      {
        text: 'Prochaines étapes :',
        style: 'sectionHeader',
      },
      {
        ul: [
          'Compléter votre profil employé',
          'Rejoindre les canaux Slack assignés',
          'Remplir le questionnaire d\'intégration',
          'Consulter le guide d\'onboarding',
        ],
      },
      { text: '\n\n' },
      {
        text: 'Bienvenue dans l\'équipe !',
        style: 'body',
        italics: true,
      },
      { text: '\n' },
      { text: 'L\'équipe RH — Kisso Industries', style: 'body', bold: true },
    ],
    styles: {
      header: { fontSize: 22, bold: true, color: '#1a365d' },
      subheader: { fontSize: 16, bold: true, color: '#2b6cb0' },
      sectionHeader: { fontSize: 13, bold: true, color: '#2d3748', margin: [0, 10, 0, 5] as [number, number, number, number] },
      body: { fontSize: 11, lineHeight: 1.5 },
    },
    defaultStyle: { font: 'Roboto' },
  };
}

function buildContract(data: Record<string, unknown>): TDocumentDefinitions {
  const today = new Date().toLocaleDateString('fr-FR');
  return {
    content: [
      { text: 'KISSO INDUSTRIES', style: 'header', alignment: 'center' as const },
      { text: 'CONTRAT DE TRAVAIL', style: 'subheader', alignment: 'center' as const },
      { text: '\n\n' },
      {
        table: {
          widths: ['*', '*'],
          body: [
            ['Employé', `${data.firstName ?? ''} ${data.lastName ?? ''}`],
            ['Email', `${data.email ?? ''}`],
            ['Département', `${data.department ?? ''}`],
            ['Poste', `${data.position ?? ''}`],
            ['Date de début', `${data.startDate ?? ''}`],
            ['Date du contrat', today],
          ],
        },
      },
      { text: '\n\n' },
      {
        text: `Le présent contrat est établi entre Kisso Industries et ${data.firstName ?? ''} ${data.lastName ?? ''} pour le poste de ${data.position ?? ''} au sein du département ${data.department ?? ''}.`,
        style: 'body',
      },
    ],
    styles: {
      header: { fontSize: 22, bold: true, color: '#1a365d' },
      subheader: { fontSize: 16, bold: true, color: '#2b6cb0' },
      body: { fontSize: 11, lineHeight: 1.5 },
    },
    defaultStyle: { font: 'Roboto' },
  };
}

function buildCertificate(data: Record<string, unknown>): TDocumentDefinitions {
  return {
    content: [
      { text: 'CERTIFICAT D\'ONBOARDING', style: 'header', alignment: 'center' as const },
      { text: '\n\n' },
      {
        text: `Nous certifions que ${data.firstName ?? ''} ${data.lastName ?? ''} a complété avec succès son programme d'intégration chez Kisso Industries.`,
        style: 'body',
        alignment: 'center' as const,
      },
      { text: '\n\n' },
      { text: `Date : ${new Date().toLocaleDateString('fr-FR')}`, alignment: 'center' as const },
    ],
    styles: {
      header: { fontSize: 24, bold: true, color: '#1a365d' },
      body: { fontSize: 13, lineHeight: 1.8 },
    },
    defaultStyle: { font: 'Roboto' },
  };
}

function buildGuide(data: Record<string, unknown>): TDocumentDefinitions {
  return {
    content: [
      { text: 'GUIDE D\'ONBOARDING', style: 'header', alignment: 'center' as const },
      { text: `Département : ${data.department ?? 'Général'}`, style: 'subheader', alignment: 'center' as const },
      { text: '\n\n' },
      { text: '1. Votre première semaine', style: 'sectionHeader' },
      { ul: ['Configuration du poste de travail', 'Accès aux outils (Slack, GitHub, Email)', 'Rencontre avec l\'équipe', 'Présentation de la culture d\'entreprise'] },
      { text: '\n' },
      { text: '2. Ressources utiles', style: 'sectionHeader' },
      { ul: ['Documentation interne sur Confluence', 'Guide LinkedIn et présence digitale', 'Politique de congés et avantages', 'Contact RH : hr@kisso.com'] },
      { text: '\n' },
      { text: '3. Objectifs du premier mois', style: 'sectionHeader' },
      { ul: ['Compléter toutes les tâches d\'onboarding', 'Participer à 3 réunions d\'équipe', 'Remplir le rapport d\'étonnement', 'Planifier un 1:1 avec votre manager'] },
    ],
    styles: {
      header: { fontSize: 22, bold: true, color: '#1a365d' },
      subheader: { fontSize: 14, color: '#4a5568' },
      sectionHeader: { fontSize: 13, bold: true, color: '#2d3748', margin: [0, 10, 0, 5] as [number, number, number, number] },
    },
    defaultStyle: { font: 'Roboto', fontSize: 11 },
  };
}

const TEMPLATE_BUILDERS: Record<TemplateId, (data: Record<string, unknown>) => TDocumentDefinitions> = {
  'TPL-contract': buildContract,
  'TPL-welcome_letter': buildWelcomeLetter,
  'TPL-certificate': buildCertificate,
  'TPL-guide': buildGuide,
};

export class PdfmakeService implements PdfService {
  private outputDir: string;

  constructor(outputDir = './data/documents') {
    this.outputDir = outputDir;
  }

  async generate(employeeData: Record<string, unknown>, templateId: string): Promise<string> {
    const builder = TEMPLATE_BUILDERS[templateId as TemplateId];
    if (!builder) {
      throw new Error(`Unknown template: ${templateId}. Available: ${Object.keys(TEMPLATE_BUILDERS).join(', ')}`);
    }

    ensureFonts();

    const docDefinition = builder(employeeData);
    const pdfDoc = pdfmake.createPdf(docDefinition);
    const buffer = await pdfDoc.getBuffer();

    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }

    const fileName = `${templateId.replace('TPL-', '')}_${(employeeData.id as string) ?? 'unknown'}_${Date.now()}.pdf`;
    const filePath = join(this.outputDir, fileName);

    writeFileSync(filePath, buffer);
    logger.info('PDF generated', { filePath, templateId, size: buffer.length });
    return filePath;
  }
}
