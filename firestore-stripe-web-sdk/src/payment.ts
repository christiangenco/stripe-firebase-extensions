/*
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FirebaseApp } from "@firebase/app";
import {
  doc,
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  FirestoreDataConverter,
  getDoc,
  getFirestore,
  QueryDocumentSnapshot,
} from "@firebase/firestore";
import { StripePayments, StripePaymentsError } from "./init";
import { getCurrentUser } from "./user";
import { checkNonEmptyString } from "./utils";

/**
 * Interface of a Stripe payment stored in the app database.
 */
export interface Payment {
  /**
   * Amount intended to be collected by this payment. A positive integer representing how much
   * to charge in the smallest currency unit (e.g., 100 cents to charge $1.00 or 100 to charge
   * ¥100, a zero-decimal currency). The minimum amount is $0.50 US or equivalent in charge
   * currency. The amount value supports up to eight digits (e.g., a value of 99999999 for a
   * USD charge of $999,999.99).
   */
  readonly amount: number;

  /**
   * Amount that can be captured from this payment.
   */
  readonly amount_capturable: number;

  /**
   * Amount that was collected by this payment.
   */
  readonly amount_received: number;

  /**
   * The date when the payment was created as a UTC timestamp.
   */
  readonly created: string;

  /**
   * Three-letter ISO currency code, in lowercase. Must be a supported currency.
   */
  readonly currency: string;

  /**
   * ID of the Customer this payment belongs to, if one exists. Payment methods attached
   * to other Customers cannot be used with this payment.
   */
  readonly customer: string | null;

  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  readonly description: string | null;

  /**
   * Unique Stripe payment ID.
   */
  readonly id: string;

  /**
   * ID of the invoice that created this payment, if it exists.
   */
  readonly invoice: string | null;

  /**
   * Set of key-value pairs that you can attach to an object. This can be useful for storing
   * additional information about the object in a structured format.
   */
  readonly metadata: { [name: string]: string };

  /**
   * The list of payment method types (e.g. card) that this payment is allowed to use.
   */
  readonly payment_method_types: string[];

  /**
   * Array of product ID and price ID pairs.
   */
  readonly prices: Array<{ product: string; price: string }>;

  /**
   * Status of this payment.
   */
  readonly status: PaymentState;

  /**
   * Firebase Auth UID of the user that created the payment.
   */
  readonly uid: string;

  readonly [propName: string]: any;
}

/**
 * Possible states a payment can be in.
 */
export type PaymentState =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "cancelled"
  | "succeeded";

/**
 * Retrieves an existing Stripe payment for the currently signed in user from the database.
 *
 * @param payments - A valid {@link StripePayments} object.
 * @param subscriptionId - ID of the payment to retrieve.
 * @returns Resolves with a Payment object if found. Rejects if the specified payment ID
 *  does not exist, or if the user is not signed in.
 */
export function getCurrentUserPayment(
  payments: StripePayments,
  paymentId: string
): Promise<Payment> {
  checkNonEmptyString(paymentId, "paymentId must be a non-empty string.");
  return getCurrentUser(payments).then((uid: string) => {
    const dao: PaymentDAO = getOrInitPaymentDAO(payments);
    return dao.getPayment(uid, paymentId);
  });
}

/**
 * Internal interface for all database interactions pertaining to Stripe payments. Exported
 * for testing.
 *
 * @internal
 */
export interface PaymentDAO {
  getPayment(uid: string, paymentId: string): Promise<Payment>;
}

const PAYMENT_CONVERTER: FirestoreDataConverter<Payment> = {
  toFirestore: () => {
    throw new Error("Not implemented for readonly Payment type.");
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot): Payment => {
    const data: DocumentData = snapshot.data();
    const refs: DocumentReference[] = data.prices;
    const prices: Array<{ product: string; price: string }> = refs.map(
      (priceRef: DocumentReference) => {
        return {
          product: priceRef.parent.parent!.id,
          price: priceRef.id,
        };
      }
    );

    return {
      amount: data.amount,
      amount_capturable: data.amount_capturable,
      amount_received: data.amount_received,
      created: toUTCDateString(data.created),
      currency: data.currency,
      customer: data.customer,
      description: data.description,
      id: snapshot.id,
      invoice: data.invoice,
      metadata: data.metadata ?? {},
      payment_method_types: data.payment_method_types,
      prices,
      status: data.status,
      uid: snapshot.ref.parent.parent!.id,
    };
  },
};

function toUTCDateString(seconds: number): string {
  const date = new Date(seconds * 1000);
  return date.toUTCString();
}

const PAYMENTS_COLLECTION = "payments" as const;

class FirestorePaymentDAO implements PaymentDAO {
  private readonly firestore: Firestore;

  constructor(app: FirebaseApp, private readonly customersCollection: string) {
    this.firestore = getFirestore(app);
  }

  public async getPayment(uid: string, paymentId: string): Promise<Payment> {
    const snap: QueryDocumentSnapshot<Payment> =
      await this.getPaymentSnapshotIfExists(uid, paymentId);
    return snap.data();
  }

  private async getPaymentSnapshotIfExists(
    uid: string,
    paymentId: string
  ): Promise<QueryDocumentSnapshot<Payment>> {
    const paymentRef: DocumentReference<Payment> = doc(
      this.firestore,
      this.customersCollection,
      uid,
      PAYMENTS_COLLECTION,
      paymentId
    ).withConverter(PAYMENT_CONVERTER);
    const snapshot: DocumentSnapshot<Payment> = await this.queryFirestore(() =>
      getDoc(paymentRef)
    );
    if (!snapshot.exists()) {
      throw new StripePaymentsError(
        "not-found",
        `No payment found with the ID: ${paymentId} for user: ${uid}`
      );
    }

    return snapshot;
  }

  private async queryFirestore<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new StripePaymentsError(
        "internal",
        "Unexpected error while querying Firestore",
        error
      );
    }
  }
}

const PAYMENT_DAO_KEY = "payment-dao" as const;

function getOrInitPaymentDAO(payments: StripePayments): PaymentDAO {
  let dao: PaymentDAO | null =
    payments.getComponent<PaymentDAO>(PAYMENT_DAO_KEY);
  if (!dao) {
    dao = new FirestorePaymentDAO(payments.app, payments.customersCollection);
    setPaymentDAO(payments, dao);
  }

  return dao;
}

/**
 * Internal API for registering a {@link PaymentDAO} instance with {@link StripePayments}.
 * Exported for testing.
 *
 * @internal
 */
export function setPaymentDAO(payments: StripePayments, dao: PaymentDAO): void {
  payments.setComponent(PAYMENT_DAO_KEY, dao);
}
