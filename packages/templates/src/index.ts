/** New papers from templates: the curated gallery, any GitHub repository or folder, Typst Universe packages, and
 *  uploaded archives, all read into one shape (`Template`) and planned into the files of a new paper (`planFiles`).
 *  The places a paper is created (a GitHub repository, a folder on disk) are the callers'. */
export { ArchiveError, DEFAULT_LIMITS, unzip, untargz, type ArchiveLimits } from './archive.ts';
export { repositoryName, safeFolder, safePath } from './paths.ts';
export { asText, detect, escapeFor, papersToml, planFiles, TEXLIVE_YEAR, TYPST_VERSION, type PlanOptions, type PlannedFile } from './plan.ts';
export {
    GALLERY_REPO,
    galleryTemplate,
    galleryUrl,
    infoOf,
    loadGallery,
    parseRepoLink,
    parseUniverseSpec,
    repoTemplate,
    templateFromSpec,
    universeTemplate,
    zipTemplate,
} from './sources.ts';
export { infoFrom, parseIndex, parseTemplateToml, TemplateError, type Field, type Format, type GalleryEntry, type Template, type TemplateInfo } from './template.ts';
