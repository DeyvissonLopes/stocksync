import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadDatabaseOptions } from './database-options.js';

export default new DataSource(loadDatabaseOptions(process.env));
