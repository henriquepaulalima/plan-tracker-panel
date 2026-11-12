# Checkout redesign

## Context

The checkout flow has three pages and loses a third of buyers on the shipping step. This plan merges it into one page.

## Steps

- [x] Audit the current checkout funnel in analytics
- [x] Design the single-page layout
  - wireframes approved by product
- [~] Build the new CheckoutPage component
  - address form
  - shipping options
  - payment form
- [ ] Wire the payment provider's hosted fields
- [-] Add a coupon field to the cart page
- [ ] Run an A/B test against the old flow
- [ ] Remove the old checkout pages

## Verification

Place a test order end to end on staging.
