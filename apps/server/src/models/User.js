/**
 * User.js — who owns a kit.
 *
 * Decides: the stored shape of an account, and the uniqueness rule on email.
 *
 * Does NOT decide: how a password is hashed or checked (the auth module), how a session
 * is issued, or who may read a kit. A model that verified passwords would put a security
 * decision in a schema file, where nobody looks for one.
 *
 * AUTH STAYS MINIMAL, BY INSTRUCTION. No email verification, no password reset, no roles.
 * There is deliberately no `role` field: adding one invites a permission check somewhere
 * that then has to be kept correct, and the brief rules role hierarchies out of scope.
 * Ownership is the only authorisation this system has, and it lives on the kit.
 *
 * EMAIL IS STORED LOWERCASED AND UNIQUE. Two accounts differing only in capitalisation
 * are the same person to everyone except a database, which is how duplicate accounts and
 * "I can't log in" both happen. The schema lowercases on write so the uniqueness index
 * means what a human would expect.
 */

import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      // Normalised on write, not just at the call site: a route that forgot would
      // otherwise create a second account for the same person.
      lowercase: true,
      trim: true,
      index: true,
    },

    /**
     * The hash only. A plaintext password never reaches this schema, and there is no
     * field it could be stored in by accident.
     */
    passwordHash: {
      type: String,
      required: true,
    },

    createdAt: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    // `updatedAt` carries no meaning for an account whose only mutable field is its
    // hash, and a misleading timestamp is worse than an absent one.
    timestamps: false,
    versionKey: false,
  }
);

/**
 * Never serialise the hash.
 *
 * Routes return documents, and a route that does so without thinking is ordinary. The
 * safe default belongs here, where it applies to every caller, rather than in each
 * response shape where one omission leaks a credential.
 */
userSchema.methods.toJSON = function toJSON() {
  return {
    id: String(this._id),
    email: this.email,
    createdAt: this.createdAt,
  };
};

export const User = mongoose.models.User ?? mongoose.model('User', userSchema);
