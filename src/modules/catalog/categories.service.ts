import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { z } from 'zod';
import { slugify } from '../../common/slug.js';
import { categories } from '../../db/schema/index.js';
import { DB, type Db } from '../../platform/database.js';
import { isForeignKeyViolation, isRestrictViolation, isUniqueViolation } from '../../platform/db-errors.js';
import { catalogErrors } from './catalog.errors.js';
import type { createCategorySchema, updateCategorySchema } from './catalog.schemas.js';

type Category = typeof categories.$inferSelect;
export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  children: CategoryNode[];
}

@Injectable()
export class CategoriesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext('catalog');
  }

  /** The whole tree, siblings ordered by position then name. */
  async tree(): Promise<CategoryNode[]> {
    const rows = await this.db
      .select()
      .from(categories)
      .orderBy(asc(categories.position), sql`${categories.name} COLLATE "und-x-icu"`);
    const nodes = new Map<string, CategoryNode>(
      rows.map((c) => [c.id, { id: c.id, name: c.name, slug: c.slug, children: [] }]),
    );
    const roots: CategoryNode[] = [];
    for (const c of rows) {
      const node = nodes.get(c.id) as CategoryNode;
      const parent = c.parentId ? nodes.get(c.parentId) : undefined;
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }

  async create(input: z.infer<typeof createCategorySchema>): Promise<Category> {
    const slug = input.slug ?? slugify(input.name);
    const [created] = await this.write(() =>
      this.db
        .insert(categories)
        .values({ name: input.name, slug, parentId: input.parentId ?? null, position: input.position ?? 0 })
        .returning(),
    );
    this.logger.info({ category_id: created?.id }, 'catalog.category.created');
    return created as Category;
  }

  async update(id: string, input: z.infer<typeof updateCategorySchema>): Promise<Category> {
    if (input.parentId) await this.assertNotDescendant(id, input.parentId);
    const [updated] = await this.write(() =>
      this.db.update(categories).set(input).where(eq(categories.id, id)).returning(),
    );
    if (!updated) throw catalogErrors.categoryNotFound();
    this.logger.info({ category_id: id }, 'catalog.category.updated');
    return updated;
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.write(() =>
      this.db.delete(categories).where(eq(categories.id, id)).returning({ id: categories.id }),
    );
    if (deleted.length === 0) throw catalogErrors.categoryNotFound();
    this.logger.info({ category_id: id }, 'catalog.category.deleted');
  }

  /** Moving a category under itself or one of its descendants would make a cycle. */
  private async assertNotDescendant(id: string, newParentId: string): Promise<void> {
    const { rows } = await this.db.execute<{ found: boolean }>(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM categories WHERE id = ${id}
        UNION ALL
        SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
      )
      SELECT EXISTS (SELECT 1 FROM subtree WHERE id = ${newParentId}) AS found`);
    if (rows[0]?.found) throw catalogErrors.categoryCycle();
  }

  private async write<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (isUniqueViolation(err, 'categories_slug_unique')) throw catalogErrors.slugTaken();
      if (isForeignKeyViolation(err, 'categories_parent_id_categories_id_fk'))
        throw catalogErrors.parentNotFound();
      if (isRestrictViolation(err)) throw catalogErrors.categoryInUse();
      throw err;
    }
  }
}
